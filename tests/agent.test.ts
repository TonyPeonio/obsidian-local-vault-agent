import { describe, expect, it } from "vitest";
import {
	AUTO_CONTINUE_TEXT,
	Agent,
	MAX_AUTO_CONTINUES,
	buildSystemPrompt,
	looksLikeChoiceQuestion,
	looksLikePermissionQuestion,
	newConversation,
	trimHistory,
	type AgentConfig,
} from "../src/agent";
import { OllamaError } from "../src/ollama";
import { keywordSearch } from "../src/search";
import { ALL_TOOLS } from "../src/tools";
import type { ApprovalDecision, ChatMessage } from "../src/types";
import { FakeOllama, FakeVault, type Scripted } from "./fakes";

const config: AgentConfig = {
	model: "fake",
	numCtx: 8192,
	temperature: 0,
	think: undefined,
	keepAlive: "1m",
	maxIterations: 4,
	maxToolResultChars: 4000,
	autoApprove: false,
	autoContinue: false,
	extraSystemPrompt: "",
};

function setup(turns: Scripted[], opts: { decision?: ApprovalDecision; cfg?: Partial<AgentConfig> } = {}) {
	const vault = new FakeVault({
		"Projects/Chess Robot.md": "# Chess Robot\n\nThe gantry moves pieces with an electromagnet.",
		"Ideas/Sensors.md": "Hall sensors are cheap.",
	});
	const ollama = new FakeOllama(turns);
	const approvals: string[] = [];
	const agent = new Agent({
		client: ollama.asClient(),
		vault,
		tools: ALL_TOOLS,
		search: (q, l) => keywordSearch(vault, q, l),
		approve: async (req) => {
			approvals.push(req.summary);
			return opts.decision ?? "approve";
		},
		getConfig: () => ({ ...config, ...opts.cfg }),
		now: () => new Date("2026-11-05T12:00:00Z"),
	});
	return { vault, ollama, agent, approvals };
}

describe("Agent.run", () => {
	it("answers directly when the model calls no tools", async () => {
		const { agent, ollama } = setup([{ content: "Hello!" }]);
		const conv = newConversation();
		const deltas: string[] = [];
		await agent.run(conv, "hi", { onAssistantDelta: (d) => deltas.push(d) });
		expect(deltas.join("")).toBe("Hello!");
		expect(conv.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(ollama.requests[0].messages[0].role).toBe("system");
		expect(ollama.requests[0].tools?.map((t) => t.function.name)).toContain("search_notes");
	});

	it("executes tool calls and feeds results back", async () => {
		const { agent, ollama } = setup([
			{ tool: "search_notes", args: { query: "gantry" } },
			{ tool: "read_note", args: { path: "Projects/Chess Robot.md" } },
			{ content: "The gantry uses an electromagnet. [[Projects/Chess Robot]]" },
		]);
		const conv = newConversation();
		const toolsRun: string[] = [];
		await agent.run(conv, "how does the gantry work?", { onToolDone: (c, _r, ok) => toolsRun.push(`${c.function.name}:${ok}`) });
		expect(toolsRun).toEqual(["search_notes:true", "read_note:true"]);
		expect(conv.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
		const toolMsg = conv.messages[2];
		expect(toolMsg.tool_name).toBe("search_notes");
		expect(toolMsg.content).toContain("Projects/Chess Robot.md");
		// The second request must carry the tool result.
		expect(ollama.requests[1].messages.at(-1)?.role).toBe("tool");
	});

	it("turns tool errors into messages the model can recover from", async () => {
		const { agent } = setup([
			{ tool: "read_note", args: { path: "Missing" } },
			{ tool: "bogus_tool", args: {} },
			{ content: "done" },
		]);
		const conv = newConversation();
		const results: string[] = [];
		await agent.run(conv, "x", { onToolDone: (_c, r, ok) => results.push(`${ok}:${r}`) });
		expect(results[0]).toMatch(/^false:Error: No note found/);
		expect(results[1]).toMatch(/^false:Error: unknown tool "bogus_tool"/);
		expect(conv.messages.at(-1)?.content).toBe("done");
	});

	it("routes mutations through approval and respects rejection", async () => {
		const { agent, vault, approvals } = setup(
			[{ tool: "edit_note", args: { path: "Ideas/Sensors", old_text: "cheap", new_text: "pricey" } }, { content: "ok" }],
			{ decision: "reject" },
		);
		const conv = newConversation();
		await agent.run(conv, "x", {});
		expect(approvals).toEqual(["Edit Ideas/Sensors.md (1 replacement)"]);
		expect(await vault.read("Ideas/Sensors.md")).toBe("Hall sensors are cheap.");
		expect(conv.messages[2].content).toMatch(/rejected/);
	});

	it("'approve all' skips later prompts in the same conversation", async () => {
		const { agent, vault, approvals } = setup(
			[
				{ tool: "edit_note", args: { path: "Ideas/Sensors", old_text: "cheap", new_text: "pricey" } },
				{ tool: "append_to_note", args: { path: "Ideas/Sensors", content: "More." } },
				{ content: "ok" },
			],
			{ decision: "approve-all" },
		);
		const conv = newConversation();
		await agent.run(conv, "x", {});
		expect(approvals).toHaveLength(1);
		expect(conv.approveAll).toBe(true);
		expect(await vault.read("Ideas/Sensors.md")).toBe("Hall sensors are pricey.\n\nMore.\n");
	});

	it("auto-approve config skips the prompt entirely", async () => {
		const { agent, approvals, vault } = setup(
			[{ tool: "create_note", args: { path: "Out", content: "x" } }, { content: "ok" }],
			{ cfg: { autoApprove: true } },
		);
		await agent.run(newConversation(), "x", {});
		expect(approvals).toHaveLength(0);
		expect(vault.exists("Out.md")).toBe(true);
	});

	it("stops after maxIterations and asks the model to wrap up", async () => {
		const loop: Scripted[] = Array.from({ length: 4 }, () => ({ tool: "list_notes", args: {} }));
		const { agent, ollama } = setup([...loop, { content: "partial answer" }], { cfg: { maxIterations: 4 } });
		const conv = newConversation();
		await agent.run(conv, "x", {});
		expect(ollama.requests).toHaveLength(5);
		const last = ollama.requests[4];
		expect(last.tools).toBeUndefined();
		expect(last.messages.at(-1)?.content).toMatch(/maximum number of tool calls/);
		expect(conv.messages.at(-1)?.content).toBe("partial answer");
	});

	it("retries without `think` when the model rejects it", async () => {
		const { agent, ollama } = setup(
			[{ error: new OllamaError('model does not support thinking') }, { content: "fine" }],
			{ cfg: { think: true } },
		);
		await agent.run(newConversation(), "x", {});
		expect(ollama.requests[0].think).toBe(true);
		expect(ollama.requests[1].think).toBeUndefined();
	});

	it("explains a model without tool support", async () => {
		const { agent } = setup([{ error: new OllamaError("registry.ollama.ai/library/x does not support tools") }]);
		await expect(agent.run(newConversation(), "x", {})).rejects.toThrow(/does not support tool calling/);
	});

	it("honours abort between tool calls", async () => {
		const controller = new AbortController();
		const { agent, ollama } = setup([
			{ tools: [{ tool: "list_notes", args: {} }, { tool: "list_notes", args: {} }] },
			{ content: "never" },
		]);
		const conv = newConversation();
		await agent.run(conv, "x", { onToolDone: () => controller.abort() }, controller.signal);
		expect(ollama.requests).toHaveLength(1);
		expect(conv.messages.filter((m) => m.role === "tool")).toHaveLength(1);
	});

	it("keeps multi-turn history across runs", async () => {
		const { agent, ollama } = setup([{ content: "one" }, { content: "two" }]);
		const conv = newConversation();
		await agent.run(conv, "first", {});
		await agent.run(conv, "second", {});
		const sent = ollama.requests[1].messages.map((m) => m.role);
		expect(sent).toEqual(["system", "user", "assistant", "user"]);
	});

	it("answers a 'shall I proceed?' for the user when autoContinue is on", async () => {
		const { agent, ollama } = setup(
			[
				{ content: "I found 3 notes with recordings.\n\nWould you like me to proceed with checking the first one?" },
				{ tool: "list_notes", args: {} },
				{ content: "All done." },
			],
			{ cfg: { autoContinue: true } },
		);
		const conv = newConversation();
		const nudges: string[] = [];
		await agent.run(conv, "clean up the recordings", { onAutoContinue: (t) => nudges.push(t) });
		expect(nudges).toEqual([AUTO_CONTINUE_TEXT]);
		expect(ollama.requests).toHaveLength(3);
		expect(ollama.requests[1].messages.at(-1)).toMatchObject({ role: "user", content: AUTO_CONTINUE_TEXT });
		expect(conv.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "tool", "assistant"]);
		expect(conv.messages.at(-1)?.content).toBe("All done.");
	});

	it("gives up after MAX_AUTO_CONTINUES permission questions", async () => {
		const ask = { content: "Shall I continue?" };
		const { agent, ollama } = setup([ask, ask, ask, ask, ask], { cfg: { autoContinue: true, maxIterations: 10 } });
		const conv = newConversation();
		await agent.run(conv, "x", {});
		expect(ollama.requests).toHaveLength(MAX_AUTO_CONTINUES + 1);
		expect(conv.messages.at(-1)?.content).toBe("Shall I continue?");
	});

	it("never auto-continues after the user rejected a change", async () => {
		const { agent, ollama } = setup(
			[
				{ tool: "delete_file", args: { path: "Ideas/Sensors" } },
				{ content: "The deletion was rejected. Would you like me to remove the link instead?" },
				{ content: "never reached" },
			],
			{ cfg: { autoContinue: true }, decision: "reject" },
		);
		const conv = newConversation();
		await agent.run(conv, "delete the sensors note", {});
		expect(ollama.requests).toHaveLength(2);
		expect(conv.messages.at(-1)?.content).toMatch(/rejected/);
	});

	it("returns a choice between alternatives to the user", async () => {
		const { agent, ollama } = setup(
			[{ content: "I can delete the notes or just remove the references.\n\nWhich would you prefer? Or do you want me to:\n- Delete both?\n- Just clean up?" }],
			{ cfg: { autoContinue: true } },
		);
		await agent.run(newConversation(), "x", {});
		expect(ollama.requests).toHaveLength(1);
	});

	it("does not auto-continue a real clarifying question or when disabled", async () => {
		const a = setup([{ content: "Which folder do you mean?" }], { cfg: { autoContinue: true } });
		await a.agent.run(newConversation(), "x", {});
		expect(a.ollama.requests).toHaveLength(1);

		const b = setup([{ content: "Would you like me to proceed?" }], { cfg: { autoContinue: false } });
		await b.agent.run(newConversation(), "x", {});
		expect(b.ollama.requests).toHaveLength(1);
	});
});

describe("grounding check", () => {
	it("sends back an answer that cites notes which do not exist", async () => {
		const { agent, ollama } = setup([
			{ content: "The magnet was weak [[Troubleshooting/Chess Robot Issues]] and [[Projects/Chess Robot]]." },
			{ tool: "search_notes", args: { query: "magnet" } },
			{ content: "The gantry uses an electromagnet [[Projects/Chess Robot]]." },
		]);
		const conv = newConversation();
		const nudges: string[] = [];
		await agent.run(conv, "magnet problems?", { onAutoContinue: (t) => nudges.push(t) });
		expect(nudges).toHaveLength(1);
		expect(nudges[0]).toMatch(/^Grounding check: you have not searched/);
		expect(nudges[0]).toContain("[[Troubleshooting/Chess Robot Issues]]");
		expect(nudges[0]).not.toContain("[[Projects/Chess Robot]]");
		expect(ollama.requests).toHaveLength(3);
		expect(conv.messages.at(-1)?.content).toMatch(/electromagnet/);
	});

	it("uses the milder wording after tools were used, and only nudges once", async () => {
		const bad = { content: "See [[Nope/Missing]]." };
		const { agent, ollama } = setup([{ tool: "list_notes", args: {} }, bad, bad]);
		const conv = newConversation();
		const nudges: string[] = [];
		await agent.run(conv, "x", { onAutoContinue: (t) => nudges.push(t) });
		expect(nudges).toHaveLength(1);
		expect(nudges[0]).toMatch(/cites notes that do not exist/);
		expect(nudges[0]).not.toMatch(/have not searched/);
		expect(ollama.requests).toHaveLength(3);
	});

	it("accepts links that resolve, including bare names, aliases and headings", async () => {
		const { agent, ollama } = setup([{ content: "See [[Chess Robot#Status|status]] and [[Ideas/Sensors]]." }]);
		await agent.run(newConversation(), "x", {});
		expect(ollama.requests).toHaveLength(1);
	});
});

describe("looksLikeChoiceQuestion", () => {
	it("recognises questions that need the user's pick", () => {
		for (const text of [
			"Which would you prefer? Or do you want me to:\n- Delete both\n- Just clean up",
			"The deletions were rejected by the approval dialog. What would you like me to do instead?",
			"Which one should I delete?",
			"Options:\n1. A\n2. B\nShall I proceed?",
		]) {
			expect(looksLikeChoiceQuestion(text), text).toBe(true);
		}
	});
	it("does not flag plain go-ahead questions", () => {
		for (const text of ["Would you like me to proceed with reading the CSCI 470 note first?", "Shall I continue?", "Done."]) {
			expect(looksLikeChoiceQuestion(text), text).toBe(false);
		}
	});
});

describe("looksLikePermissionQuestion", () => {
	it("matches the ways small models ask for the go-ahead", () => {
		for (const text of [
			"Would you like me to check the full content of any specific note?",
			"### Next Steps\n- Read the note.\n\nWould you like me to proceed with reading the **School/CSCI 470** note first?",
			"I can delete the link once we confirm. Shall I proceed?",
			"Do you want me to continue with the remaining notes?",
			"Ready to proceed?",
		]) {
			expect(looksLikePermissionQuestion(text), text).toBe(true);
		}
	});
	it("ignores answers and genuine clarifying questions", () => {
		for (const text of [
			"Here is the summary of your notes.",
			"Which folder do you mean, Projects or Archive?",
			"Let me know if you want more detail.",
			"Did you mean the 2026 syllabus or the 2025 one?",
			"",
		]) {
			expect(looksLikePermissionQuestion(text), text).toBe(false);
		}
	});
});

describe("buildSystemPrompt", () => {
	it("mentions vault size, date, active note and extra instructions", () => {
		const vault = new FakeVault({ "A.md": "a", "B.md": "b" });
		vault.activePath = "A.md";
		const p = buildSystemPrompt(vault, { ...config, extraSystemPrompt: "Be terse." }, new Date("2026-11-05T00:00:00Z"));
		expect(p).toContain("2 markdown notes");
		expect(p).toContain("Today is 2026-11-05");
		expect(p).toContain("A.md");
		expect(p).toContain("Be terse.");
	});
});

describe("trimHistory", () => {
	const msg = (role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content, ...extra });

	it("returns everything when under budget", () => {
		const m = [msg("user", "hi"), msg("assistant", "yo")];
		expect(trimHistory(m, 8192)).toEqual(m);
	});

	it("always drops thinking from earlier turns but keeps the current one", () => {
		const m = [msg("user", "q1"), msg("assistant", "a1", { thinking: "old" }), msg("user", "q2"), msg("assistant", "", { thinking: "new" })];
		const out = trimHistory(m, 8192);
		expect(out[1].thinking).toBeUndefined();
		expect(out[3].thinking).toBe("new");
		expect(m[1].thinking).toBe("old"); // input untouched
	});

	it("shortens old tool results before dropping turns", () => {
		const big = "x".repeat(5000);
		const m = [
			msg("user", "q1"),
			msg("assistant", "", { tool_calls: [{ function: { name: "t", arguments: {} } }] }),
			msg("tool", big, { tool_name: "t" }),
			msg("assistant", "a1", { thinking: "y".repeat(3000) }),
			msg("user", "q2"),
		];
		const out = trimHistory(m, 2048); // budget ≈ 3932 chars
		expect(out.map((x) => x.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
		expect(out[2].content.length).toBeLessThan(500);
		expect(out[3].thinking).toBeUndefined();
	});

	it("drops whole early turns when still over budget and never starts on a tool message", () => {
		const m = [
			msg("user", "q1"),
			msg("assistant", "a".repeat(3000)),
			msg("user", "q2"),
			msg("assistant", "b".repeat(3000)),
			msg("user", "q3"),
		];
		const out = trimHistory(m, 1024);
		expect(out[0].role).toBe("user");
		expect(out[0].content).toBe("q3");
	});
});
