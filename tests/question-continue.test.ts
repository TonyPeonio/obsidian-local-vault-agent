import { describe, expect, it } from "vitest";
import {
	Agent,
	AUTO_CONTINUE_TEXT,
	FOLLOW_THROUGH_TEXT,
	MAX_AUTO_CONTINUES,
	QUESTION_CONTINUE_TEXT,
	QUESTION_FOLLOW_THROUGH_TEXT,
	UNASKED_WRITE_CAUTION,
	asksOnlyAQuestion,
	isAgentLine,
	newConversation,
	offersChange,
	type AgentConfig,
} from "../src/agent";
import { keywordSearch } from "../src/search";
import { ALL_TOOLS } from "../src/tools";
import { conversationToMarkdown } from "../src/transcript";
import type { ApprovalDecision, ApprovalRequest } from "../src/types";
import { FakeOllama, FakeVault, type Scripted } from "./fakes";

const config: AgentConfig = {
	model: "fake",
	numCtx: 8192,
	temperature: 0,
	think: undefined,
	keepAlive: "1m",
	maxIterations: 10,
	maxToolResultChars: 4000,
	autoApprove: true,
	autoContinue: true,
	extraSystemPrompt: "",
	preSearch: false,
	citations: "off",
};

const QUESTION = "Which of my daily notes have a Capture section with real content? List each note.";
const REQUEST = "Compile the Capture sections of my daily notes into a new note.";
const NOTES = {
	"Daily/2026-06-12.md": "# 2026-06-12\n\n## Capture\n\nCluster commands I keep forgetting: salloc -N 1.",
	"Daily/2026-07-09.md": "# 2026-07-09\n\n## Capture\n\nSnippet from the ML homework: rolling_mean.",
};
const OFFER = "I found 2 daily notes with a substantial Capture section. I can read each one and compile them into a new note.\n\nWould you like me to proceed?";
const ANSWER = "Two notes have real content:\n- [[Daily/2026-06-12]]: cluster commands\n- [[Daily/2026-07-09]]: an ML homework snippet\n\nIf you want, I can compile them into a new note.";

function setup(turns: Scripted[], opts: { decision?: ApprovalDecision; cfg?: Partial<AgentConfig> } = {}) {
	const vault = new FakeVault({ ...NOTES });
	const ollama = new FakeOllama(turns);
	const approvals: ApprovalRequest[] = [];
	const agent = new Agent({
		client: ollama.asClient(),
		vault,
		tools: ALL_TOOLS,
		search: (q, l) => keywordSearch(vault, q, l),
		approve: async (req) => {
			approvals.push(req);
			return opts.decision ?? "approve";
		},
		getConfig: () => ({ ...config, ...opts.cfg }),
		now: () => new Date("2026-11-05T12:00:00Z"),
	});
	return { vault, ollama, agent, approvals };
}

/** Every line the agent sent to the model in the user's place, over all requests. */
function agentLines(ollama: FakeOllama): string[] {
	const last = ollama.requests.at(-1)?.messages ?? [];
	return last.filter((m) => m.role === "user" && isAgentLine(m.content)).map((m) => m.content);
}

describe("a model that asks to go on, in a turn where the user asked only a question", () => {
	it("takes the two prompts of these tests for what they are", () => {
		expect(asksOnlyAQuestion(QUESTION)).toBe(true);
		expect(asksOnlyAQuestion(REQUEST)).toBe(false);
	});

	it("is not answered yes: it is told to answer and change nothing, and the reply that ends the turn holds the answer", async () => {
		const { agent, ollama, vault, approvals } = setup([{ tool: "list_notes", args: { folder: "Daily" } }, { content: OFFER }, { content: ANSWER }]);
		const conv = newConversation();
		const nudges: string[] = [];
		await agent.run(conv, QUESTION, { onAutoContinue: (n) => nudges.push(n) });
		expect(nudges).toEqual([QUESTION_CONTINUE_TEXT]);
		// Nothing the model was sent in this turn says yes for the user.
		for (const req of ollama.requests) expect(req.messages.some((m) => m.content === AUTO_CONTINUE_TEXT)).toBe(false);
		expect(ollama.requests[2].messages.at(-1)).toMatchObject({ role: "user", content: QUESTION_CONTINUE_TEXT });
		expect(approvals).toHaveLength(0);
		expect(vault.listNotes().map((n) => n.path).sort()).toEqual(Object.keys(NOTES).sort());
		const final = conv.messages.at(-1)?.content ?? "";
		expect(final).toContain("[[Daily/2026-06-12]]");
		expect(final).toContain("[[Daily/2026-07-09]]");
		expect(final).toContain("If you want, I can compile them into a new note.");
	});

	it("ends the turn when the answer that follows asks again: the offer is the user's to accept", async () => {
		const again = `${ANSWER.replace("If you want, I can compile them into a new note.", "")}Shall I go ahead?`;
		const { agent, ollama, approvals } = setup([{ tool: "list_notes", args: { folder: "Daily" } }, { content: OFFER }, { content: again }, { content: "never reached" }]);
		const conv = newConversation();
		await agent.run(conv, QUESTION, {});
		expect(ollama.requests).toHaveLength(3);
		expect(agentLines(ollama)).toEqual([QUESTION_CONTINUE_TEXT]);
		expect(conv.messages.at(-1)?.content).toContain("[[Daily/2026-06-12]]");
		expect(approvals).toHaveLength(0);
	});

	it("shows a change the model makes all the same with the unasked-change warning, though changes are approved automatically", async () => {
		const { agent, vault, approvals } = setup(
			[{ content: OFFER }, { tool: "create_note", args: { path: "Summaries/Capture Compilation.md", content: "# Capture Compilation" } }, { content: ANSWER }],
			{ decision: "reject" },
		);
		const conv = newConversation();
		await agent.run(conv, QUESTION, {});
		expect(approvals).toHaveLength(1);
		expect(approvals[0].caution).toBe(UNASKED_WRITE_CAUTION);
		expect(vault.exists("Summaries/Capture Compilation.md")).toBe(false);
	});

	it("pushes on a search the model stopped to ask about, each time it has read something since", async () => {
		const { agent, ollama } = setup([
			{ content: "The Capture sections are in the daily notes.\n\nShall I continue reading the other notes?" },
			{ tool: "read_note", args: { path: "Daily/2026-06-12.md" } },
			{ content: "The first one holds cluster commands. Do you want me to check the remaining notes?" },
			{ tool: "read_note", args: { path: "Daily/2026-07-09.md" } },
			{ content: ANSWER },
		]);
		const conv = newConversation();
		const tools: string[] = [];
		await agent.run(conv, QUESTION, { onToolDone: (c) => tools.push(c.function.name) });
		expect(agentLines(ollama)).toEqual([QUESTION_CONTINUE_TEXT, QUESTION_CONTINUE_TEXT]);
		expect(tools).toEqual(["read_note", "read_note"]);
		expect(conv.messages.at(-1)?.content).toContain("[[Daily/2026-07-09]]");
	});

	it("pushes on a read the model only announced, with the line that names no change", async () => {
		const { agent, ollama } = setup([
			{ content: "The daily notes have Capture sections.\n\nLet me look at the 2026-06-12 note." },
			{ tool: "read_note", args: { path: "Daily/2026-06-12.md" } },
			{ content: ANSWER },
		]);
		const conv = newConversation();
		const nudges: string[] = [];
		await agent.run(conv, QUESTION, { onAutoContinue: (n) => nudges.push(n) });
		expect(nudges).toEqual([QUESTION_FOLLOW_THROUGH_TEXT]);
		expect(QUESTION_FOLLOW_THROUGH_TEXT).not.toMatch(/approval dialog/);
		expect(ollama.requests).toHaveLength(3);
		expect(conv.messages.at(-1)?.content).toContain("[[Daily/2026-06-12]]");
	});

	it("stops after MAX_AUTO_CONTINUES such questions even when tools ran in between", async () => {
		const stall: Scripted[] = [];
		for (let i = 0; i < MAX_AUTO_CONTINUES + 1; i++) stall.push({ tool: "read_note", args: { path: "Daily/2026-06-12.md", from_line: i + 1 } }, { content: "Shall I continue?" });
		const { agent, ollama } = setup(stall, { cfg: { maxIterations: 20 } });
		await agent.run(newConversation(), QUESTION, {});
		expect(agentLines(ollama)).toHaveLength(MAX_AUTO_CONTINUES);
	});
});

describe("a model that asks to go on, in a turn where the user asked for a change", () => {
	it("is answered yes as before, and the change it then makes is approved without a dialog", async () => {
		const { agent, ollama, vault, approvals } = setup([
			{ content: OFFER },
			{ tool: "create_note", args: { path: "Summaries/Capture Compilation.md", content: "# Capture Compilation" } },
			{ content: "Created [[Summaries/Capture Compilation]]." },
		]);
		const conv = newConversation();
		const nudges: string[] = [];
		await agent.run(conv, REQUEST, { onAutoContinue: (n) => nudges.push(n) });
		expect(nudges).toEqual([AUTO_CONTINUE_TEXT]);
		expect(ollama.requests[1].messages.at(-1)).toMatchObject({ role: "user", content: AUTO_CONTINUE_TEXT });
		expect(approvals).toHaveLength(0);
		expect(vault.exists("Summaries/Capture Compilation.md")).toBe(true);
	});

	it("is pushed to take an announced step with the line that allows changes", async () => {
		const { agent } = setup([
			{ content: "Both notes are read.\n\nNow I'll create the new note." },
			{ tool: "create_note", args: { path: "Summaries/Capture Compilation.md", content: "# Capture Compilation" } },
			{ content: "Created [[Summaries/Capture Compilation]]." },
		]);
		const nudges: string[] = [];
		await agent.run(newConversation(), REQUEST, { onAutoContinue: (n) => nudges.push(n) });
		expect(nudges).toEqual([FOLLOW_THROUGH_TEXT]);
	});
});

describe("offersChange", () => {
	it("is true for a closing offer of a change, which in a question turn ends the turn", () => {
		for (const text of [ANSWER, "Here is the list.\n\nI can merge the two notes if you'd like.", "Done reading. If you would like, I can also fix the broken links."]) expect(offersChange(text), text).toBe(true);
	});

	it("is false for an offer to read on, for an announced change and for an offer made earlier in the reply", () => {
		for (const text of ["If you want, I can search the other notes.", "Now I'll create the new note.", "If you want, I can compile them.\n\nThe notes are listed above."]) expect(offersChange(text), text).toBe(false);
	});

	it("leaves an offer to read on, in a question turn, to be pushed on", async () => {
		const { agent } = setup([{ content: "The first note has commands.\n\nIf you want, I can check the other daily notes." }, { tool: "read_note", args: { path: "Daily/2026-07-09.md" } }, { content: ANSWER }]);
		const nudges: string[] = [];
		await agent.run(newConversation(), QUESTION, { onAutoContinue: (n) => nudges.push(n) });
		expect(nudges).toEqual([QUESTION_FOLLOW_THROUGH_TEXT]);
	});

	it("is not consulted in a request turn: the offer is pushed into the step, as before", async () => {
		const { agent } = setup([{ content: "Both notes are read.\n\nIf you want, I can create the new note now." }, { tool: "create_note", args: { path: "Summaries/Capture Compilation.md", content: "# C" } }, { content: "Created." }]);
		const nudges: string[] = [];
		await agent.run(newConversation(), REQUEST, { onAutoContinue: (n) => nudges.push(n) });
		expect(nudges).toEqual([FOLLOW_THROUGH_TEXT]);
	});
});

describe("the lines the agent sends in the user's place", () => {
	it("are told from what the user wrote", () => {
		for (const line of [AUTO_CONTINUE_TEXT, QUESTION_CONTINUE_TEXT, FOLLOW_THROUGH_TEXT, QUESTION_FOLLOW_THROUGH_TEXT, "Grounding check: your answer cites notes that do not exist.", "Your reply was empty. Answer now."]) {
			expect(isAgentLine(line), line).toBe(true);
		}
		expect(isAgentLine("Yes. Continue.")).toBe(false);
		expect(isAgentLine(QUESTION)).toBe(false);
	});

	it("are not copied out as the user's words", () => {
		const md = conversationToMarkdown([
			{ role: "user", content: QUESTION },
			{ role: "assistant", content: OFFER },
			{ role: "user", content: QUESTION_CONTINUE_TEXT },
			{ role: "assistant", content: ANSWER },
		]);
		expect(md).not.toContain(QUESTION_CONTINUE_TEXT);
		expect(md).toContain("told to finish the answer and change nothing");
	});
});
