import { describe, expect, it } from "vitest";
import { Agent, ContextTooSmallError, fitsWindow, newConversation, replyCap, turnBudget, type AgentConfig } from "../src/agent";
import LocalVaultAgentPlugin from "../src/main";
import { OllamaClient, type PlainRequest } from "../src/ollama";
import { effectiveContext, modelContext } from "../src/openai";
import { QuizEngine, sourceBudget } from "../src/quiz";
import { keywordSearch } from "../src/search";
import { DEFAULT_SETTINGS } from "../src/settings";
import { ALL_TOOLS } from "../src/tools";
import type { UsageInfo } from "../src/types";
import { FakeOllama, FakeVault, type Scripted } from "./fakes";

/**
 * The context window an OpenAI-compatible server really has. Ollama is told a size with every
 * request; LM Studio, llama.cpp and the others have the one the model was loaded with, and cut the
 * start of a longer prompt (the instructions) without a word.
 */

describe("modelContext", () => {
	it("reads llama.cpp's meta.n_ctx and LM Studio's loaded_context_length for the model asked about", () => {
		const llamacpp = { data: [{ id: "qwen3.5:4b", aliases: ["qwen"], meta: { n_ctx: 4096, n_ctx_train: 262144 } }] };
		expect(modelContext(llamacpp, "qwen3.5:4b")).toBe(4096);
		expect(modelContext(llamacpp, "QWEN")).toBe(4096);
		const lmStudio = { data: [{ id: "other", loaded_context_length: 8192 }, { id: "qwen", loaded_context_length: 4096, max_context_length: 32768 }] };
		expect(modelContext(lmStudio, "qwen")).toBe(4096);
	});

	it("is undefined when the server does not say, or says it of another model", () => {
		expect(modelContext({ data: [{ id: "qwen" }] }, "qwen")).toBeUndefined();
		expect(modelContext({ data: [{ id: "a", meta: { n_ctx: 4096 } }, { id: "b", meta: { n_ctx: 8192 } }] }, "c")).toBeUndefined();
		// A model that is listed but not loaded has only the size it could be loaded with.
		expect(modelContext({ data: [{ id: "qwen", max_context_length: 32768 }] }, "qwen")).toBeUndefined();
		expect(modelContext({}, "qwen")).toBeUndefined();
		// One model served under a name the server does not echo (llama.cpp without --alias): it is that one.
		expect(modelContext({ data: [{ id: "C:/models/blob", meta: { n_ctx: 4096 } }] }, "qwen")).toBe(4096);
	});
});

describe("effectiveContext", () => {
	it("is the smaller of the setting and what the server reports, and the setting when it reports nothing", () => {
		expect(effectiveContext(32768, 4096)).toBe(4096);
		expect(effectiveContext(8192, 32768)).toBe(8192);
		expect(effectiveContext(32768, undefined)).toBe(32768);
		expect(effectiveContext(32768, 0)).toBe(32768);
	});
});

/** An OpenAI-compatible server: `/models` with or without a window, and a chat that answers in one piece. */
function server(state: { ctx?: number; down?: boolean }) {
	const calls: string[] = [];
	const fetchImpl = ((url: string | URL | Request) => {
		calls.push(String(url));
		if (state.down) throw new TypeError("fetch failed");
		if (String(url).endsWith("/models")) return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "qwen", meta: state.ctx ? { n_ctx: state.ctx } : {} }] })));
		return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { headers: { "content-type": "application/json" } }));
	}) as typeof fetch;
	return { calls, fetchImpl, asked: () => calls.filter((u) => u.endsWith("/models")).length };
}

describe("OllamaClient.loadedContext", () => {
	it("asks once per server address and model, and again only when either changes or it is told to", async () => {
		const state = { ctx: 4096 };
		const s = server(state);
		let url = "http://127.0.0.1:8091/v1";
		const client = new OllamaClient(() => url, s.fetchImpl, undefined, undefined, () => ({ kind: "openai" }));
		expect(client.knownContext("qwen")).toBeUndefined();
		expect(await client.loadedContext("qwen")).toBe(4096);
		for (let i = 0; i < 5; i++) expect(await client.loadedContext("qwen")).toBe(4096);
		expect(s.asked()).toBe(1);
		expect(client.knownContext("qwen")).toBe(4096);

		// Another model, then another address: each is asked about once.
		await client.loadedContext("other");
		await client.loadedContext("other");
		expect(s.asked()).toBe(2);
		url = "http://127.0.0.1:1234/v1";
		expect(client.knownContext("qwen")).toBeUndefined();
		await client.loadedContext("qwen");
		await client.loadedContext("qwen");
		expect(s.asked()).toBe(3);

		// The model was loaded again with more: what was learned stays until the server is asked anew.
		state.ctx = 16384;
		expect(await client.loadedContext("qwen")).toBe(4096);
		expect(await client.loadedContext("qwen", true)).toBe(16384);
		expect(client.knownContext("qwen")).toBe(16384);
		expect(s.asked()).toBe(4);
	});

	it("makes one request for callers that ask at the same moment", async () => {
		const s = server({ ctx: 4096 });
		const client = new OllamaClient(() => "http://x/v1", s.fetchImpl, undefined, undefined, () => ({ kind: "openai" }));
		expect(await Promise.all([client.loadedContext("qwen"), client.loadedContext("qwen"), client.loadedContext("qwen", true)])).toEqual([4096, 4096, 4096]);
		expect(s.asked()).toBe(1);
	});

	it("does not remember a server it could not reach", async () => {
		const state: { ctx?: number; down?: boolean } = { ctx: 4096, down: true };
		const s = server(state);
		const client = new OllamaClient(() => "http://x/v1", s.fetchImpl, undefined, undefined, () => ({ kind: "openai" }));
		expect(await client.loadedContext("qwen")).toBeUndefined();
		state.down = false;
		expect(await client.loadedContext("qwen")).toBe(4096);
		// Unreachable when asked anew: what was learned before still holds.
		state.down = true;
		expect(await client.loadedContext("qwen", true)).toBe(4096);
	});

	it("remembers that a server does not say, until the model has answered once", async () => {
		const state: { ctx?: number } = {};
		const s = server(state);
		const client = new OllamaClient(() => "http://x/v1", s.fetchImpl, undefined, undefined, () => ({ kind: "openai" }));
		expect(await client.loadedContext("qwen")).toBeUndefined();
		expect(await client.loadedContext("qwen")).toBeUndefined();
		expect(s.asked()).toBe(1);
		// A server that loads the model on its first request can say the size only now: asked once more, in the background.
		state.ctx = 4096;
		await client.chat({ model: "qwen", messages: [{ role: "user", content: "hi" }] });
		await new Promise((r) => setTimeout(r, 0));
		expect(s.asked()).toBe(2);
		expect(client.knownContext("qwen")).toBe(4096);
		// And not after every reply.
		await client.chat({ model: "qwen", messages: [{ role: "user", content: "hi" }] });
		await new Promise((r) => setTimeout(r, 0));
		expect(s.asked()).toBe(2);
	});

	it("still does not ask after every reply when the server never says", async () => {
		const s = server({});
		const client = new OllamaClient(() => "http://x/v1", s.fetchImpl, undefined, undefined, () => ({ kind: "openai" }));
		await client.loadedContext("qwen");
		for (let i = 0; i < 4; i++) await client.chat({ model: "qwen", messages: [{ role: "user", content: "hi" }] });
		await new Promise((r) => setTimeout(r, 0));
		expect(s.asked()).toBe(2);
		expect(client.knownContext("qwen")).toBeUndefined();
	});

	it("reads LM Studio's own list when the OpenAI-style one has no size", async () => {
		const urls: string[] = [];
		const plain: PlainRequest = async (url) => {
			urls.push(url);
			if (url.endsWith("/v1/models")) return { status: 200, text: JSON.stringify({ data: [{ id: "qwen" }] }) };
			return { status: 200, text: JSON.stringify({ data: [{ id: "qwen", state: "loaded", loaded_context_length: 4096, max_context_length: 32768 }] }) };
		};
		const client = new OllamaClient(() => "http://localhost:1234/v1", undefined, undefined, plain, () => ({ kind: "openai" }));
		expect(await client.loadedContext("qwen")).toBe(4096);
		expect(urls).toEqual(["http://localhost:1234/v1/models", "http://localhost:1234/api/v0/models"]);
	});

	it("asks Ollama nothing: Ollama takes the size the plugin sends", async () => {
		const s = server({ ctx: 4096 });
		const client = new OllamaClient(() => "http://localhost:11434", s.fetchImpl);
		expect(await client.loadedContext("qwen", true)).toBeUndefined();
		expect(client.knownContext("qwen")).toBeUndefined();
		expect(s.calls).toEqual([]);
	});
});

describe("fitsWindow", () => {
	it("says whether the fixed part leaves room for a reply and the least conversation", () => {
		// 30,000 characters of instructions and tools are about 9,400 tokens.
		expect(fitsWindow(4096, 30000)).toBe(false);
		expect(fitsWindow(8192, 30000)).toBe(false);
		expect(fitsWindow(16384, 30000)).toBe(true);
		expect(fitsWindow(32768, 30000)).toBe(true);
		// Exactly where turnBudget stops being more than its floor.
		const fixed = Math.floor((16384 - 2048) * 3.2 * 0.97) - 6000;
		expect(fitsWindow(16384, fixed)).toBe(true);
		expect(fitsWindow(16384, fixed + 1)).toBe(false);
		expect(turnBudget(16384, fixed + 1)).toBe(6000);
		// Denser text than assumed: the same characters are more tokens.
		expect(fitsWindow(16384, fixed, 2.8)).toBe(false);
	});
});

const config: AgentConfig = {
	model: "fake",
	numCtx: 32768,
	temperature: 0,
	think: undefined,
	keepAlive: "1m",
	maxIterations: 4,
	maxToolResultChars: 4000,
	autoApprove: false,
	autoContinue: false,
	extraSystemPrompt: "",
};

function setup(turns: Scripted[], serverContext: number | undefined, getConfig: () => AgentConfig = () => ({ ...config })) {
	const vault = new FakeVault({
		"Projects/Chess Robot.md": "# Chess Robot\n\nThe gantry moves pieces with an electromagnet.",
		"Ideas/Sensors.md": "Hall sensors are cheap.",
	});
	const ollama = new FakeOllama(turns);
	ollama.serverContext = serverContext;
	const asked: string[] = [];
	const agent = new Agent({
		client: ollama.asClient(),
		vault,
		tools: ALL_TOOLS,
		search: (q, l) => keywordSearch(vault, q, l),
		approve: async (req) => {
			asked.push(req.summary);
			return "approve";
		},
		getConfig,
		now: () => new Date("2026-11-05T12:00:00Z"),
	});
	return { vault, ollama, agent, asked };
}

describe("Agent with a server that says how large its window is", () => {
	it("budgets for the server's window when it is smaller than the setting", async () => {
		const { agent, ollama } = setup([{ content: "Hello!" }, { content: "Again." }], 16384);
		const usage: UsageInfo[] = [];
		const conv = newConversation();
		await agent.run(conv, "hi", { onUsage: (u) => usage.push(u) });
		await agent.run(conv, "and again", {});
		const [first, second] = ollama.requests;
		expect(first.options?.num_ctx).toBe(16384);
		expect(first.options?.num_predict).toBe(replyCap(16384));
		// The same prompt for the next message: the window is not looked at differently from turn to turn.
		expect(second.messages[0]).toEqual(first.messages[0]);
		// A plain question each time, never "ask the server anew": the client answers from what it remembers.
		expect(ollama.contextAsks).toEqual([
			{ model: "fake", again: false },
			{ model: "fake", again: false },
		]);
	});

	it("reports the context used against the server's window, not the setting", async () => {
		const { agent } = setup([{ content: "Hello!", promptTokens: 9000 }], 16384);
		const usage: UsageInfo[] = [];
		await agent.run(newConversation(), "hi", { onUsage: (u) => usage.push(u) });
		expect(usage[0].numCtx).toBe(16384);
	});

	it("keeps the setting when the server has more, and when it does not say", async () => {
		for (const reported of [65536, undefined]) {
			const { agent, ollama } = setup([{ content: "Hello!" }], reported);
			await agent.run(newConversation(), "hi", {});
			expect(ollama.requests[0].options?.num_ctx).toBe(32768);
			expect(ollama.requests[0].options?.num_predict).toBe(replyCap(32768));
		}
	});

	it("ends the run at once, with the sizes and what to do, when the instructions do not fit the server's window", async () => {
		const { agent, ollama } = setup([{ content: "never sent" }], 4096);
		const conv = newConversation();
		conv.messages.push({ role: "user", content: "earlier" }, { role: "assistant", content: "earlier answer", thinking: "kept" });
		const before = JSON.stringify(conv.messages);
		const err = await agent.run(conv, "hi", {}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ContextTooSmallError);
		const e = err as ContextTooSmallError;
		expect(e.serverContext).toBe(4096);
		expect(e.needed).toBeGreaterThan(4096);
		expect(e.needed).toBeLessThanOrEqual(32768);
		expect(e.message).toContain("fake");
		expect(e.message).toContain("4096 tokens");
		expect(e.message).toContain(`at least ${e.needed}`);
		expect(e.message).toContain("LM Studio: the context length slider");
		expect(e.message).toContain(`-c ${Math.max(16384, e.needed)} or more`);
		// Nothing went to the model, and the conversation is as it was: no message added, no earlier turn trimmed to the small window.
		expect(ollama.requests).toHaveLength(0);
		expect(JSON.stringify(conv.messages)).toBe(before);
	});

	it("names a size that the same prompt then really fits", async () => {
		const first = setup([{ content: "never sent" }], 4096);
		const e = (await first.agent.run(newConversation(), "hi", {}).catch((x: unknown) => x)) as ContextTooSmallError;
		const second = setup([{ content: "Hello!" }], e.needed);
		await second.agent.run(newConversation(), "hi", {});
		expect(second.ollama.requests).toHaveLength(1);
		expect(second.ollama.requests[0].options?.num_ctx).toBe(e.needed);
	});

	it("asks the server anew on the next message after refusing, so loading the model with more is enough", async () => {
		const { agent, ollama } = setup([{ content: "Hello!" }], 4096);
		const conv = newConversation();
		await expect(agent.run(conv, "hi", {})).rejects.toBeInstanceOf(ContextTooSmallError);
		ollama.serverContext = 32768;
		await agent.run(conv, "hi", {});
		expect(conv.messages.map((m) => m.content)).toEqual(["hi", "Hello!"]);
		expect(ollama.requests[0].options?.num_ctx).toBe(32768);
		// (No reply is scripted for this one; only how the server was asked matters.)
		await agent.run(conv, "more", {}).catch(() => undefined);
		expect(ollama.contextAsks.map((a) => a.again)).toEqual([false, true, false]);
	});

	/** The plugin's own agentConfig(), which is already narrowed to the window the client last learned. */
	function pluginSetup(turns: Scripted[], serverContext: number) {
		const settings = { ...DEFAULT_SETTINGS };
		const holder: { client?: unknown } = {};
		const made = setup(turns, serverContext, () => LocalVaultAgentPlugin.prototype.agentConfig.call({ settings, client: holder.client } as unknown as LocalVaultAgentPlugin));
		holder.client = made.ollama.asClient();
		return made;
	}

	it("budgets the message after a refusal for the window the model was loaded with since, not the one last learned", async () => {
		const { agent, ollama } = pluginSetup([{ content: "Hello!" }], 4096);
		const conv = newConversation();
		await expect(agent.run(conv, "hi", {})).rejects.toBeInstanceOf(ContextTooSmallError);
		// The user did what the message said, with a window still below the setting of 32768.
		ollama.serverContext = 16384;
		await agent.run(conv, "hi", {});
		expect(ollama.requests).toHaveLength(1);
		expect(ollama.requests[0].options?.num_ctx).toBe(16384);
		expect(ollama.requests[0].options?.num_predict).toBe(replyCap(16384));
	});

	it("warms the prompt for the window the server has now, which is the prompt the turn then sends", async () => {
		const { agent, ollama } = pluginSetup([{ content: "" }, { content: "hello" }], 16384);
		await ollama.loadedContext("learned earlier");
		// Loaded again with more before the chat box is focused.
		ollama.serverContext = 24576;
		await agent.warm();
		await agent.run(newConversation(), "hi", {});
		const [warm, first] = ollama.requests;
		expect(warm.options?.num_ctx).toBe(24576);
		expect(first.options?.num_ctx).toBe(24576);
		expect(warm.messages[0]).toEqual(first.messages[0]);
	});

	it("does not refuse when it is the plugin's own setting that is small: that is as it always was", async () => {
		const { agent, ollama } = setup([{ content: "Hello!" }], 32768, () => ({ ...config, numCtx: 4096 }));
		await agent.run(newConversation(), "hi", {});
		expect(ollama.requests[0].options?.num_ctx).toBe(4096);
	});

	it("keeps reading a live setting through the narrowed configuration", async () => {
		// The plugin's own configuration object: auto-approve is a getter over the settings, read at every write.
		const settings = { ...DEFAULT_SETTINGS, autoApproveEdits: true };
		const client = new FakeOllama([]).asClient();
		const getConfig = (): AgentConfig => LocalVaultAgentPlugin.prototype.agentConfig.call({ settings, client } as unknown as LocalVaultAgentPlugin);
		const { agent, ollama, asked } = setup(
			[{ tool: "edit_note", args: { path: "Ideas/Sensors", old_text: "cheap", new_text: "pricey" } }, { tool: "append_to_note", args: { path: "Ideas/Sensors", content: "More." } }, { content: "ok" }],
			16384,
			getConfig,
		);
		const conv = newConversation();
		await agent.run(conv, "Change cheap to pricey in Ideas/Sensors and add a line.", {
			onToolDone: () => {
				settings.autoApproveEdits = false;
			},
		});
		expect(ollama.requests[0].options?.num_ctx).toBe(16384);
		// The first write went through unasked; after "Turn off", the second showed its diff.
		expect(asked).toHaveLength(1);
	});
});

describe("warm-up with a server that says how large its window is", () => {
	it("asks the server anew, and reads the prompt the turn will send", async () => {
		const { agent, ollama } = setup([{ content: "" }, { content: "hello" }], 16384);
		await agent.warm();
		await agent.run(newConversation(), "hi", {});
		expect(ollama.contextAsks).toEqual([
			{ model: "fake", again: true },
			{ model: "fake", again: false },
		]);
		const [warm, first] = ollama.requests;
		expect(warm.options?.num_ctx).toBe(16384);
		expect(warm.messages[0]).toEqual(first.messages[0]);
	});

	it("sends nothing when the prompt does not fit: the first message says why", async () => {
		const { agent, ollama } = setup([{ content: "never sent" }], 4096);
		await agent.warm();
		expect(ollama.requests).toHaveLength(0);
		await expect(agent.run(newConversation(), "hi", {})).rejects.toBeInstanceOf(ContextTooSmallError);
	});
});

describe("the plugin's own configuration", () => {
	const plugin = (over: Record<string, unknown>) => ({ settings: { ...DEFAULT_SETTINGS }, ...over }) as unknown as LocalVaultAgentPlugin;

	it("hands out the smaller of the setting and what the client last learned, without asking", async () => {
		const client = new FakeOllama([]);
		const p = plugin({ client });
		expect(LocalVaultAgentPlugin.prototype.agentConfig.call(p).numCtx).toBe(DEFAULT_SETTINGS.numCtx);
		client.serverContext = 8192;
		await client.loadedContext(DEFAULT_SETTINGS.model);
		const asks = client.contextAsks.length;
		expect(LocalVaultAgentPlugin.prototype.agentConfig.call(p).numCtx).toBe(8192);
		expect(LocalVaultAgentPlugin.prototype.numCtx.call(p)).toBe(8192);
		expect(client.contextAsks).toHaveLength(asks);
	});

	it("asks the server anew when the chat box is focused, even with the warm-up switched off", () => {
		const client = new FakeOllama([]);
		let warmed = 0;
		const p = plugin({ client, agentBusy: false, jobRunning: false, lastWarm: 0, agent: { warm: async () => void warmed++ } });
		p.settings.warmUp = false;
		LocalVaultAgentPlugin.prototype.warmModel.call(p);
		expect(client.contextAsks).toEqual([{ model: DEFAULT_SETTINGS.model, again: true }]);
		expect(warmed).toBe(0);
		// At most once per interval, like the warm-up itself.
		LocalVaultAgentPlugin.prototype.warmModel.call(p);
		expect(client.contextAsks).toHaveLength(1);
	});

	it("leaves the asking to the warm-up when that is on", () => {
		const client = new FakeOllama([]);
		let warmed = 0;
		const p = plugin({ client, agentBusy: false, jobRunning: false, lastWarm: 0, agent: { warm: async () => void warmed++ } });
		LocalVaultAgentPlugin.prototype.warmModel.call(p);
		expect(warmed).toBe(1);
		expect(client.contextAsks).toEqual([]);
	});
});

describe("sourceBudget", () => {
	it("is 40,000 characters unless a server said its window is too small for that", () => {
		expect(sourceBudget(undefined)).toBe(40000);
		expect(sourceBudget(32768)).toBe(40000);
		expect(sourceBudget(16384)).toBe(40000);
		expect(sourceBudget(8192)).toBe(Math.floor((8192 - 2048) * 3.2 * 0.9));
		expect(sourceBudget(4096)).toBe(Math.floor(2048 * 3.2 * 0.9));
		expect(sourceBudget(2048)).toBe(3000);
	});
});

describe("QuizEngine with a server that says how large its window is", () => {
	const reply = { content: JSON.stringify({ questions: [] }) };
	const note = { path: "L.md", content: `# Lecture\n\n${"The contamination parameter defaults to 0.05. ".repeat(1200)}` };

	it("cuts the notes to what the server's window holds, and sends the effective size", async () => {
		const ollama = new FakeOllama([reply]);
		const engine = new QuizEngine(ollama.asClient(), async () => ({ model: "m", numCtx: 4096, keepAlive: "1m", serverCtx: 4096 }));
		await engine.questions("ML", [note], 5);
		expect(ollama.requests[0].options?.num_ctx).toBe(4096);
		expect(ollama.requests[0].messages[0].content.length).toBeLessThan(sourceBudget(4096) + 2500);
	});

	it("keeps ten notes within the server's window too, where 1,500 characters of each would not fit", async () => {
		const ollama = new FakeOllama([reply]);
		const engine = new QuizEngine(ollama.asClient(), async () => ({ model: "m", numCtx: 4096, keepAlive: "1m", serverCtx: 4096 }));
		const notes = Array.from({ length: 10 }, (_, i) => ({ path: `L${i}.md`, content: note.content }));
		await engine.questions("ML", notes, 5);
		// 4096 tokens are about 13,000 characters, the reply included.
		expect(ollama.requests[0].messages[0].content.length).toBeLessThan(sourceBudget(4096) + 2500);
		for (const n of notes) expect(ollama.requests[0].messages[0].content).toContain(`--- ${n.path} ---`);
	});

	it("gives each of many notes its 1,500 characters as before when no small window is reported", async () => {
		const notes = Array.from({ length: 40 }, (_, i) => ({ path: `L${i}.md`, content: note.content }));
		for (const serverCtx of [undefined, 32768]) {
			const ollama = new FakeOllama([reply]);
			const engine = new QuizEngine(ollama.asClient(), () => ({ model: "m", numCtx: 32768, keepAlive: "1m", serverCtx }));
			await engine.questions("ML", notes, 5);
			expect(ollama.requests[0].messages[0].content.length).toBeGreaterThan(40 * 1500);
		}
	});

	it("sends what it always sent when the server does not say", async () => {
		const ollama = new FakeOllama([reply]);
		const engine = new QuizEngine(ollama.asClient(), () => ({ model: "m", numCtx: 8192, keepAlive: "1m" }));
		await engine.questions("ML", [note], 5);
		expect(ollama.requests[0].options?.num_ctx).toBe(8192);
		expect(ollama.requests[0].messages[0].content.length).toBeGreaterThan(38000);
	});
});
