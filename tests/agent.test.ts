import { describe, expect, it } from "vitest";
import {
	AUTO_CONTINUE_TEXT,
	Agent,
	FOLLOW_THROUGH_TEXT,
	announcesNextStep,
	MAX_AUTO_CONTINUES,
	MAX_CALLS_PER_STEP,
	REJECTED_WRITE_NOTICE,
	REJECTION_QUESTION,
	REPEATED_CALLS_WRAP_UP,
	buildSystemPrompt,
	callKey,
	invalidateCache,
	linkifyNotePaths,
	looksLikeChoiceQuestion,
	looksLikePermissionQuestion,
	newConversation,
	pickSources,
	trimHistory,
	compactHistory,
	historyBudget,
	HISTORY_CTX_CAP,
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
		expect(conv.messages[2].content).toMatch(/REJECTED/);
		// "ok" is not a question: the decision is handed back to the user regardless.
		expect(conv.messages.at(-1)?.content).toBe(`ok\n\n${REJECTION_QUESTION}`);
	});

	it("refuses every further write after a rejection without asking the user again", async () => {
		const { agent, vault, approvals } = setup(
			[
				{ tool: "edit_note", args: { path: "Ideas/Sensors", old_text: "cheap", new_text: "pricey" } },
				{ tool: "edit_note", args: { path: "Ideas/Sensors", old_text: "cheap", new_text: "costly" } },
				{ content: "I could not apply it. Would you prefer a footnote instead?" },
			],
			{ decision: "reject" },
		);
		const conv = newConversation();
		const results: string[] = [];
		await agent.run(conv, "x", { onToolDone: (_c, r) => results.push(r) });
		expect(approvals).toHaveLength(1);
		expect(results[1]).toBe(REJECTED_WRITE_NOTICE);
		expect(await vault.read("Ideas/Sensors.md")).toBe("Hall sensors are cheap.");
		expect(conv.messages.at(-1)?.content).toBe("I could not apply it. Would you prefer a footnote instead?");
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
		const loop: Scripted[] = Array.from({ length: 4 }, (_, i) => ({ tool: "list_notes", args: { limit: i + 1 } }));
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

	it("sends a reply that only announces the next step back once", async () => {
		const { agent, ollama } = setup(
			[
				{ content: "The note names the net but not the loss.\n\nTo find the validation loss, I'll check the Sensors note." },
				{ tool: "read_note", args: { path: "Ideas/Sensors.md" } },
				{ content: "Hall sensors are cheap." },
			],
			{ cfg: { autoContinue: true } },
		);
		const conv = newConversation();
		const nudges: string[] = [];
		await agent.run(conv, "what is the loss?", { onAutoContinue: (t) => nudges.push(t) });
		expect(nudges).toEqual([FOLLOW_THROUGH_TEXT]);
		expect(ollama.requests[1].messages.at(-1)).toMatchObject({ role: "user", content: FOLLOW_THROUGH_TEXT });
		expect(conv.messages.at(-1)?.content).toContain("Hall sensors are cheap.");
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

	it("ignores quoted embeds, code and attachment links in a report", async () => {
		const { agent, ollama } = setup([
			{
				content:
					"Removed `![[Recording 20260921130651.m4a]]` from [[Ideas/Sensors]].\n\n```\n[[Not/A/Citation]]\n```\nThe slides are in ![[Deck.pdf]] and [[notes.pdf]].",
			},
		]);
		await agent.run(newConversation(), "x", {});
		expect(ollama.requests).toHaveLength(1);
	});
});

describe("announcesNextStep", () => {
	it("recognises a reply that ends by narrating work not yet done", () => {
		for (const t of [
			"The note does not mention the loss.\n\nTo find it, I'll check the [[NNUE Training]] note.",
			"Let me search the Daily folder for that phrase.",
			"Now I will read the remaining three notes and apply the edits.",
			"Next, I need to grep the vault for the recording embeds.",
		]) {
			expect(announcesNextStep(t), t).toBe(true);
		}
	});

	it("leaves answers, questions and sign-offs alone", () => {
		for (const t of [
			"The validation loss was 0.071 ([[NNUE Training]]).",
			"I'll check the other notes too. Shall I continue?",
			"Done. Let me know if you want me to check the other courses.",
			"I checked both notes; neither mentions wheels.",
			"",
		]) {
			expect(announcesNextStep(t), t).toBe(false);
		}
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
	it("ignores answers, genuine clarifying questions and offers of new work", () => {
		for (const text of [
			"Here is the summary of your notes.",
			"Which folder do you mean, Projects or Archive?",
			"Let me know if you want more detail.",
			"Did you mean the 2026 syllabus or the 2025 one?",
			"The magnet drags neighbours [[Projects/Chess Robot]].\n\nWould you like me to create a consolidated note about the magnet problems?",
			"Would you like me to also write a summary of these lectures?",
			"Do you want me to set up a tracking note for this?",
			"",
		]) {
			expect(looksLikePermissionQuestion(text), text).toBe(false);
		}
	});
});

describe("buildSystemPrompt", () => {
	it("mentions vault size, date, active note, outline, conventions and extra instructions", () => {
		const vault = new FakeVault({ "A.md": "# Alpha\n\na", "Sub/B.md": "b" });
		vault.activePath = "A.md";
		const p = buildSystemPrompt(vault, { ...config, extraSystemPrompt: "Be terse." }, new Date("2026-11-05T00:00:00Z"), "Daily notes live in Daily/.");
		expect(p).toContain("2 markdown notes");
		expect(p).toContain("Today is 2026-11-05");
		expect(p).toContain("A.md");
		expect(p).toContain("Vault outline");
		expect(p).toContain("  A.md — Alpha");
		expect(p).toContain("Sub/\n  B.md");
		expect(p).toContain("vault conventions");
		expect(p).toContain("Daily notes live in Daily/.");
		expect(p).toContain("Be terse.");
		expect(buildSystemPrompt(vault, config, new Date())).not.toContain("vault conventions");
		const withDaily = buildSystemPrompt(vault, config, new Date(), null, undefined, { path: "Daily/2026-11-06.md", exists: false });
		expect(withDaily).toContain("Today's daily note is Daily/2026-11-06.md (it does not exist yet");
	});

	it("is given the conventions note on every run", async () => {
		const { agent, ollama } = setup([{ content: "ok" }]);
		const conv = newConversation();
		await agent.run(conv, "x", {});
		expect(ollama.requests[0].messages[0].content).not.toContain("vault conventions");
		const withNote = new Agent({
			client: ollama.asClient(),
			vault: new FakeVault(),
			tools: ALL_TOOLS,
			search: async () => [],
			approve: async () => "approve",
			getConfig: () => config,
			readConventions: async () => "Never touch Archive/.",
		});
		ollama["turns"].push({ content: "ok" });
		await withNote.run(newConversation(), "x", {});
		expect(ollama.requests[1].messages[0].content).toContain("Never touch Archive/.");
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

	it("caps the budget at the 32k window however large num_ctx is", () => {
		expect(historyBudget(16384)).toBe(Math.floor(16384 * 3.2 * 0.6));
		expect(historyBudget(32768)).toBe(Math.floor(HISTORY_CTX_CAP * 3.2 * 0.6));
		expect(historyBudget(98304)).toBe(historyBudget(32768));
		const m = [msg("user", "q1"), msg("assistant", "a".repeat(70000)), msg("user", "q2")];
		expect(trimHistory(m, 98304).map((x) => x.content)).toEqual(["q2"]);
	});
});

describe("compactHistory", () => {
	const msg = (role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content, ...extra });

	it("permanently drops reasoning and shortens tool results of finished turns", () => {
		const m = [
			msg("user", "q1"),
			msg("assistant", "", { tool_calls: [{ function: { name: "t", arguments: {} } }], thinking: "hmm" }),
			msg("tool", "x".repeat(5000), { tool_name: "t" }),
			msg("assistant", "a1"),
		];
		compactHistory(m, 32768);
		expect(m).toHaveLength(4);
		expect(m[1].thinking).toBeUndefined();
		expect(m[2].content.length).toBeLessThan(500);
		expect(m[2].content).toContain("[earlier tool result shortened]");
		// Already compact: a second pass changes nothing, so the prefix stays stable.
		const snapshot = JSON.stringify(m);
		compactHistory(m, 32768);
		expect(JSON.stringify(m)).toBe(snapshot);
	});

	it("drops the oldest turns while over budget and never leaves a tool message first", () => {
		const m = [msg("user", "q1"), msg("assistant", "a".repeat(3000)), msg("user", "q2"), msg("assistant", "b".repeat(3000))];
		compactHistory(m, 1024);
		expect(m.map((x) => x.content)).toEqual(["q2", "b".repeat(3000)]);
		const t = [msg("tool", "orphan", { tool_name: "t" }), msg("user", "q")];
		compactHistory(t, 32768);
		expect(t[0].role).toBe("user");
	});

	it("leaves a short history alone", () => {
		const m = [msg("user", "q1"), msg("assistant", "short")];
		compactHistory(m, 32768);
		expect(m).toEqual([msg("user", "q1"), msg("assistant", "short")]);
	});
});

describe("linkifyNotePaths", () => {
	it("turns backticked note paths into wikilinks and leaves everything else", () => {
		const vault = new FakeVault({ "Projects/Chess Robot.md": "x", "Ideas/Sensors.md": "y" });
		const text = "See `Projects/Chess Robot.md` and `Ideas/Sensors` but not `npm test`, `Nope/Missing.md` or\n```\n`Projects/Chess Robot.md`\n```";
		expect(linkifyNotePaths(text, vault)).toBe(
			"See [[Projects/Chess Robot]] and [[Ideas/Sensors]] but not `npm test`, `Nope/Missing.md` or\n```\n`Projects/Chess Robot.md`\n```",
		);
	});
	it("is applied to assistant replies", async () => {
		const { agent } = setup([{ content: "It is in `Projects/Chess Robot.md`." }]);
		const conv = newConversation();
		await agent.run(conv, "x", {});
		expect(conv.messages.at(-1)?.content).toBe("It is in [[Projects/Chess Robot]].");
	});
});

describe("context guards", () => {
	const msg = (role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content, ...extra });

	it("shortens this turn's older tool results when the window is full, keeping the last two", () => {
		const big = (tag: string) => `# ${tag}.md\n` + "x".repeat(3000);
		const m = [
			msg("user", "clean up"),
			msg("assistant", "", { tool_calls: [{ function: { name: "read_note", arguments: {} } }] }),
			msg("tool", big("A"), { tool_name: "read_note" }),
			msg("tool", big("B"), { tool_name: "read_note" }),
			msg("tool", big("C"), { tool_name: "read_note" }),
			msg("tool", big("D"), { tool_name: "read_note" }),
		];
		const shortened: string[] = [];
		const out = trimHistory(m, 2048, (t) => shortened.push(t.content.slice(0, 7))); // budget ≈ 3932 chars
		expect(out[2].content).toMatch(/shortened to save context/);
		expect(out[3].content).toMatch(/shortened to save context/);
		expect(out[4].content.length).toBe(big("C").length);
		expect(out[5].content.length).toBe(big("D").length);
		expect(shortened).toEqual(["# A.md\n", "# B.md\n"]);
	});

	it("caps a huge batch of tool results and nudges once on an empty reply", async () => {
		const vault = new FakeVault({});
		for (let i = 0; i < 12; i++) vault.seed(`N${i}.md`, "y".repeat(3000));
		const ollama = new FakeOllama([
			{ tools: Array.from({ length: 12 }, (_, i) => ({ tool: "read_note", args: { path: `N${i}` } })) },
			{ content: "" },
			{ content: "Here is the answer." },
		]);
		const agent = new Agent({
			client: ollama.asClient(),
			vault,
			tools: ALL_TOOLS,
			search: async () => [],
			approve: async () => "approve",
			getConfig: () => ({ ...config, numCtx: 4096, maxToolResultChars: 4000 }),
		});
		const conv = newConversation();
		const nudges: string[] = [];
		await agent.run(conv, "read everything", { onAutoContinue: (t) => nudges.push(t) });
		const results = conv.messages.filter((m) => m.role === "tool");
		expect(results.filter((r) => /truncated: this batch/.test(r.content)).length).toBeGreaterThan(0);
		expect(results[0].content.length).toBeGreaterThan(1000); // the first results survive
		expect(nudges).toHaveLength(1);
		expect(nudges[0]).toMatch(/reply was empty/);
		expect(conv.messages.at(-1)?.content).toMatch(/^Here is the answer\.\n\nSources: \[\[N0\]\]/);
	});
});

describe("sources footer", () => {
	it("picks the search hits the answer mentions, or all of a few", () => {
		const hits = ["School/CSCI 470 - Machine Learning/Lectures - CSCI 470.md", "Projects/Chess Robot.md", "Daily/2026-10-14.md", "Recipes/Pasta.md"];
		expect(pickSources("The lecture in CSCI 470 - Machine Learning was on 2026-11-06.", hits)).toEqual([hits[0]]);
		expect(pickSources("It was decided on 2026-10-14.", hits)).toEqual([hits[2]]);
		expect(pickSources("Nothing specific.", hits)).toEqual([]);
		expect(pickSources("Nothing specific.", hits.slice(0, 3))).toEqual(hits.slice(0, 3));
		expect(pickSources("x", [])).toEqual([]);
	});

	it("names the note whose passage the answer quotes, not a note that shares the subject's name", () => {
		const lecture = "School/CSCI 470 - Machine Learning/Lectures - CSCI 470.md";
		const paper = "Research/Isolation Forest.md";
		const texts = new Map([
			[lecture, "**[12:16]** So the idea behind isolation forest is this.\n\n**[21:29]** In the demo I set contamination to 0.05, so the model flags the top five percent of points as anomalies."],
			[paper, "Anomalies are few and different, so random splits isolate them in short paths."],
		]);
		const answer = 'The professor mentioned **contamination** at **[21:29]**:\n\n> "In the demo I set contamination to 0.05, so the model flags the top five percent of points as anomalies."\n\nThis is the isolation forest parameter.';
		expect(pickSources(answer, [lecture, paper], texts)).toEqual([lecture]);
		// A short quoted phrase inside a longer sentence counts too.
		expect(pickSources('The professor emphasized that "the model flags the top five percent" in the demo, an isolation forest detail.', [lecture, paper], texts)).toEqual([lecture]);
		// Without passage text the name mention still decides.
		expect(pickSources(answer, [lecture, paper])).toEqual([paper]);
		// Nothing quoted: back to the name rule.
		expect(pickSources("Isolation forest isolates anomalies in short paths, see the paper.", [lecture, paper], texts)).toEqual([paper]);
	});

	it("cites the notes a grep matched when the answer came straight from the matching lines", async () => {
		const { agent } = setup([{ tool: "grep_vault", args: { pattern: "electromagnet" } }, { content: "It moves pieces with an electromagnet." }]);
		const conv = newConversation();
		await agent.run(conv, "how does it move pieces?", {});
		expect(conv.messages.at(-1)?.content).toBe("It moves pieces with an electromagnet.\n\nSources: [[Projects/Chess Robot]]");
	});

	it("appends the notes read when an answer cites nothing, and not after writes", async () => {
		const { agent } = setup([
			{ tool: "read_note", args: { path: "Projects/Chess Robot" } },
			{ tool: "read_section", args: { path: "Projects/Chess Robot", heading: "Chess Robot" } },
			{ content: "The gantry uses an electromagnet." },
		]);
		const conv = newConversation();
		await agent.run(conv, "how does it move pieces?", {});
		expect(conv.messages.at(-1)?.content).toBe("The gantry uses an electromagnet.\n\nSources: [[Projects/Chess Robot]]");

		const b = setup([{ tool: "read_note", args: { path: "Ideas/Sensors" } }, { content: "See [[Ideas/Sensors]]." }]);
		const conv2 = newConversation();
		await b.agent.run(conv2, "x", {});
		expect(conv2.messages.at(-1)?.content).toBe("See [[Ideas/Sensors]].");

		const c = setup([
			{ tool: "read_note", args: { path: "Ideas/Sensors" } },
			{ tool: "edit_note", args: { path: "Ideas/Sensors", old_text: "cheap", new_text: "pricey" } },
			{ content: "Done." },
		]);
		const conv3 = newConversation();
		await c.agent.run(conv3, "x", {});
		expect(conv3.messages.at(-1)?.content).toBe("Done.");
	});
});

describe("per-step call cap", () => {
	it("runs the first eight calls of a step and refuses the rest with a hint", async () => {
		const vault = new FakeVault({});
		for (let i = 0; i < 12; i++) vault.seed(`N${i}.md`, `note ${i}`);
		const ollama = new FakeOllama([
			{ tools: Array.from({ length: 12 }, (_, i) => ({ tool: "read_note", args: { path: `N${i}` } })) },
			{ content: "ok [[N0]]" },
		]);
		const agent = new Agent({ client: ollama.asClient(), vault, tools: ALL_TOOLS, search: async () => [], approve: async () => "approve", getConfig: () => config });
		const conv = newConversation();
		const done: boolean[] = [];
		await agent.run(conv, "x", { onToolDone: (_c, _r, ok) => done.push(ok) });
		expect(done.filter(Boolean)).toHaveLength(MAX_CALLS_PER_STEP);
		expect(done.filter((ok) => !ok)).toHaveLength(4);
		expect(conv.messages.filter((m) => m.role === "tool" && /Not executed/.test(m.content))).toHaveLength(4);
	});
});

describe("repeated-call guard", () => {
	const grep = { tool: "grep_vault", args: { pattern: "^\\s*>\\s+[A-Z]", regex: false, folder: "/", limit: 100 } };

	it("refuses an identical read-only call, counts repeats, and ends the turn at the cap", async () => {
		// Four identical calls are scripted; the turn ends at the third repeat (fourth call), so
		// the wrap-up request gets the final scripted turn.
		const same: Scripted[] = Array.from({ length: 4 }, () => grep);
		const { agent, ollama } = setup([...same, { content: "gave up" }], { cfg: { maxIterations: 20 } });
		const conv = newConversation();
		const done: { name: string; result: string; ok: boolean }[] = [];
		await agent.run(conv, "find quotes", { onToolDone: (c, r, ok) => done.push({ name: c.function.name, result: r, ok }) });
		// First call runs; repeats 1–3 are refused; the turn ends at the third repeat, so the
		// fifth scripted call is never requested.
		expect(done).toHaveLength(4);
		expect(done[0].ok).toBe(true);
		expect(done[1].result).toMatch(/already called grep_vault with exactly these arguments.*repeat 1 of 3/s);
		expect(done[1].result).toContain(done[0].result.slice(0, 50));
		expect(done[3].result).toMatch(/repeat 3 of 3/);
		expect(done[3].result).toMatch(/turn now ends/);
		expect(ollama.requests).toHaveLength(5);
		const wrap = ollama.requests[4];
		expect(wrap.tools).toBeUndefined();
		expect(wrap.messages.at(-1)?.content).toBe(REPEATED_CALLS_WRAP_UP);
		expect(conv.messages.at(-1)?.content).toBe("gave up");
	});

	it("treats argument order as irrelevant and a changed argument as a new call", async () => {
		const { agent, ollama } = setup(
			[
				{ tool: "grep_vault", args: { pattern: "gantry", folder: "Projects" } },
				{ tool: "grep_vault", args: { folder: "Projects", pattern: "gantry" } },
				{ tool: "grep_vault", args: { pattern: "gantry", folder: "Ideas" } },
				{ content: "done" },
			],
			{ cfg: { maxIterations: 10 } },
		);
		const results: string[] = [];
		await agent.run(newConversation(), "x", { onToolDone: (_c, r) => results.push(r) });
		expect(results[0]).toMatch(/^1 matching line/);
		expect(results[1]).toMatch(/already called/);
		expect(results[2]).toMatch(/^No note contains/);
		expect(ollama.requests).toHaveLength(4);
	});

	it("forgets reads of a written note and vault-wide results, but not reads of other notes", async () => {
		const { agent } = setup(
			[
				{ tool: "read_note", args: { path: "Ideas/Sensors.md" } },
				{ tool: "read_note", args: { path: "Chess Robot" } },
				{ tool: "grep_vault", args: { pattern: "switches" } },
				{ tool: "append_to_note", args: { path: "Ideas/Sensors.md", content: "Reed switches too." } },
				{ tool: "read_note", args: { path: "Ideas/Sensors.md" } },
				{ tool: "read_note", args: { path: "Chess Robot" } },
				{ tool: "grep_vault", args: { pattern: "switches" } },
				{ content: "done" },
			],
			{ cfg: { maxIterations: 12, autoApprove: true } },
		);
		const results: string[] = [];
		await agent.run(newConversation(), "x", { onToolDone: (_c, r) => results.push(r) });
		expect(results[4]).not.toMatch(/already called/);
		expect(results[4]).toContain("Reed switches too.");
		expect(results[5]).toMatch(/already called read_note/);
		expect(results[2]).toMatch(/^No note contains/);
		expect(results[6]).toMatch(/^1 matching line/);
	});

	it("invalidates by note name however the path was spelled", () => {
		const cache = new Map<string, string>([
			['read_note {"path":"Chess Robot"}', "a"],
			['read_section {"heading":"Status","path":"Projects/Chess Robot.md"}', "b"],
			['read_note {"path":"Ideas/Sensors.md"}', "c"],
			['list_sections {"containing":["x"]}', "d"],
		]);
		invalidateCache(cache, ["Projects/Chess Robot.md"]);
		expect(Array.from(cache.keys())).toEqual(['read_note {"path":"Ideas/Sensors.md"}']);
	});

	it("lets the model call again for a result that trimHistory shortened", async () => {
		// A tiny window: the first read's result is shortened once two newer results exist, and
		// the model is told to call again; that call must run, not be refused as a repeat.
		// Three 1.5k results each pass the per-step batch cap (25% of a 2k window) but together
		// exceed the history budget (60%), so the oldest is shortened before the fourth request.
		const big = "x".repeat(1500);
		const { agent, ollama, vault } = setup(
			[
				{ tool: "read_note", args: { path: "Big/A.md" } },
				{ tool: "read_note", args: { path: "Big/B.md" } },
				{ tool: "read_note", args: { path: "Big/C.md" } },
				{ tool: "read_note", args: { path: "Big/A.md" } },
				{ content: "done" },
			],
			{ cfg: { numCtx: 2048, maxIterations: 10 } },
		);
		for (const n of ["A", "B", "C"]) vault.seed(`Big/${n}.md`, `# ${n}\n\n${big}`);
		const results: string[] = [];
		await agent.run(newConversation(), "x", { onToolDone: (_c, r) => results.push(r) });
		expect(ollama.requests[3].messages.some((m) => /shortened to save context/.test(m.content))).toBe(true);
		expect(results[3]).not.toMatch(/already called/);
		expect(results[3]).toContain(big);
	});

	it("canonicalises keys", () => {
		const a = callKey({ function: { name: "t", arguments: { b: [1, { y: 2, x: 1 }], a: "s", c: undefined } } });
		const b = callKey({ function: { name: "t", arguments: { a: "s", b: [1, { x: 1, y: 2 }] } } });
		expect(a).toBe(b);
		expect(callKey({ function: { name: "t", arguments: { a: "s" } } })).not.toBe(a);
	});
});

describe("sampling and prompt reuse", () => {
	it("sends the configured sampling options with every request", async () => {
		const { agent, ollama } = setup([{ tool: "list_notes", args: {} }, { content: "ok" }], {
			cfg: { sampling: { top_p: 0.9, top_k: 20, presence_penalty: 0.5 } },
		});
		await agent.run(newConversation(), "x", {});
		for (const req of ollama.requests) {
			expect(req.options).toEqual({ num_ctx: 8192, temperature: 0, top_p: 0.9, top_k: 20, presence_penalty: 0.5 });
		}
	});

	it("builds the system prompt once per turn so a write does not change it mid-turn", async () => {
		const { agent, ollama } = setup(
			[{ tool: "create_note", args: { path: "Ideas/New.md", content: "# New\n\nhi" } }, { tool: "list_notes", args: {} }, { content: "done" }],
			{ cfg: { autoApprove: true, maxIterations: 10 } },
		);
		await agent.run(newConversation(), "x", {});
		const systems = ollama.requests.map((r) => r.messages[0].content);
		expect(systems).toHaveLength(3);
		expect(systems[1]).toBe(systems[0]);
		expect(systems[2]).toBe(systems[0]);
		expect(systems[0]).not.toContain("New.md");
	});
});

describe("trimHistory after dropped turns", () => {
	const msg = (role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content, ...extra });
	it("still shortens the current turn's results when earlier turns were dropped", () => {
		const big = (tag: string) => `# ${tag}.md\n` + "x".repeat(3000);
		const m = [
			msg("user", "q1"),
			msg("assistant", "a".repeat(2000)),
			msg("user", "q2"),
			msg("assistant", "", { tool_calls: [{ function: { name: "read_note", arguments: {} } }] }),
			msg("tool", big("A"), { tool_name: "read_note" }),
			msg("tool", big("B"), { tool_name: "read_note" }),
			msg("tool", big("C"), { tool_name: "read_note" }),
			msg("tool", big("D"), { tool_name: "read_note" }),
		];
		const out = trimHistory(m, 2048);
		expect(out[0].content).toBe("q2");
		expect(out[2].content).toMatch(/shortened to save context/);
		expect(out[5].content.length).toBe(big("D").length);
	});
});
