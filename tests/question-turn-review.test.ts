import { describe, expect, it } from "vitest";
import {
	Agent,
	AUTO_CONTINUE_TEXT,
	FOLLOW_THROUGH_TEXT,
	MAX_AUTO_CONTINUES,
	QUESTION_CONTINUE_TEXT,
	QUESTION_FOLLOW_THROUGH_TEXT,
	REJECTION_QUESTION,
	UNASKED_WRITE_CAUTION,
	asksOnlyAQuestion,
	asksToReadOn,
	newConversation,
	type AgentConfig,
	type Conversation,
} from "../src/agent";
import { editSelectionPrompt, processDailyNotesPrompt, reformatPrompt } from "../src/prompts";
import { keywordSearch } from "../src/search";
import { ALL_TOOLS } from "../src/tools";
import type { ApprovalDecision, ApprovalRequest } from "../src/types";
import { FakeOllama, FakeVault, type Scripted } from "./fakes";

// Written in review of the question-turn change: scripted models that try to get a change accepted
// in a turn where the user asked only a question, and the cases that must stay as they were.

const config: AgentConfig = {
	model: "fake",
	numCtx: 8192,
	temperature: 0,
	think: undefined,
	keepAlive: "1m",
	maxIterations: 12,
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
const LIST = "Two notes have real content:\n- [[Daily/2026-06-12]]: cluster commands\n- [[Daily/2026-07-09]]: an ML homework snippet";
const ANSWER = `${LIST}\n\nIf you want, I can compile them into a new note.`;
const CREATE: Scripted = { tool: "create_note", args: { path: "Summaries/Capture Compilation.md", content: "# Capture Compilation" } };
const CREATED = "Summaries/Capture Compilation.md";

async function run(turns: Scripted[], prompt: string, opts: { decision?: ApprovalDecision; cfg?: Partial<AgentConfig>; conv?: Conversation } = {}) {
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
			return opts.decision ?? "reject";
		},
		getConfig: () => ({ ...config, ...opts.cfg }),
		now: () => new Date("2026-11-05T12:00:00Z"),
	});
	const conv = opts.conv ?? newConversation();
	const nudges: string[] = [];
	const tools: string[] = [];
	await agent.run(conv, prompt, { onAutoContinue: (n) => nudges.push(n), onToolDone: (c) => tools.push(c.function.name) });
	/** Whether any line the model was ever sent in this turn accepts, or allows, a change in the user's name. */
	const saidYes = ollama.requests.some((r) => r.messages.some((m) => m.role === "user" && (m.content === AUTO_CONTINUE_TEXT || m.content.startsWith(FOLLOW_THROUGH_TEXT))));
	return { vault, ollama, approvals, nudges, tools, saidYes, final: conv.messages.at(-1)?.content ?? "", conv };
}

const holdsTheAnswer = (reply: string) => reply.includes("[[Daily/2026-06-12]]") && reply.includes("[[Daily/2026-07-09]]");

describe("review: an offer to change the vault, in a turn that only asked a question", () => {
	it("is never accepted when it is phrased as a question, whatever verb it uses, and the reply that ends the turn holds the answer", async () => {
		for (const offer of [
			"Shall I compile these into a new note?",
			"Shall I go ahead and create a summary note?",
			"Should I move them into a Topics folder?",
			"Do you want me to put them in one note?",
			"Want me to merge the two notes?",
			"May I tidy up these notes?",
			"Shall I proceed with compiling them?",
			"Should I go ahead?",
			"Would you like me to do that for all of them?",
			"Ready to proceed?",
		]) {
			// A model that takes whatever it is sent next as the go-ahead.
			const r = await run([{ content: `${LIST}\n\n${offer}` }, CREATE, { content: `${LIST}\n\nThe note was not created.` }], QUESTION);
			expect(r.saidYes, offer).toBe(false);
			for (const n of r.nudges) expect([QUESTION_CONTINUE_TEXT, QUESTION_FOLLOW_THROUGH_TEXT], offer).toContain(n);
			// The change it makes all the same is shown with the warning, though changes are approved automatically.
			for (const a of r.approvals) expect(a.caution, offer).toBe(UNASKED_WRITE_CAUTION);
			expect(r.vault.exists(CREATED), offer).toBe(false);
			expect(holdsTheAnswer(r.final), offer).toBe(true);
		}
	});

	it("is not accepted when it stands in the middle of the reply", async () => {
		for (const reply of [
			`I found 2 notes. Would you like me to proceed and compile them into one note? Here they are:\n- [[Daily/2026-06-12]]: cluster commands\n- [[Daily/2026-07-09]]: an ML homework snippet`,
			`Do you want me to go ahead? This is what I would put into the note:\n- [[Daily/2026-06-12]]: cluster commands\n- [[Daily/2026-07-09]]: an ML homework snippet`,
			`Shall I continue? I can compile them into a new note.\n\n${LIST}`,
		]) {
			const r = await run([{ content: reply }, { content: ANSWER }], QUESTION);
			expect(r.saidYes, reply).toBe(false);
			expect(r.approvals, reply).toHaveLength(0);
			expect(holdsTheAnswer(r.final), reply).toBe(true);
		}
	});

	it("a plan of reads followed by a write: the reads are pushed on, the write is shown with the warning and not made", async () => {
		const r = await run(
			[
				{ content: "The daily notes have Capture sections.\n\nI'll read both notes and then create a summary note from them." },
				{ tools: [{ tool: "read_note", args: { path: "Daily/2026-06-12.md" } }, { tool: "read_note", args: { path: "Daily/2026-07-09.md" } }] },
				CREATE,
				{ content: LIST },
			],
			QUESTION,
		);
		expect(r.nudges).toEqual([QUESTION_FOLLOW_THROUGH_TEXT]);
		expect(r.saidYes).toBe(false);
		expect(r.tools).toEqual(["read_note", "read_note", "create_note"]);
		expect(r.approvals).toHaveLength(1);
		expect(r.approvals[0].caution).toBe(UNASKED_WRITE_CAUTION);
		expect(r.vault.exists(CREATED)).toBe(false);
		expect(holdsTheAnswer(r.final)).toBe(true);
		expect(r.final).toContain(REJECTION_QUESTION);
	});

	it("a write tool called outright, with no offer, is shown with the warning: with auto-approve, after 'approve all', and never made on Reject", async () => {
		const auto = await run([CREATE, { content: LIST }], QUESTION);
		expect(auto.approvals.map((a) => a.caution)).toEqual([UNASKED_WRITE_CAUTION]);
		expect(auto.vault.exists(CREATED)).toBe(false);
		expect(holdsTheAnswer(auto.final)).toBe(true);

		const conv = newConversation();
		conv.approveAll = true;
		const all = await run([CREATE, { content: LIST }], QUESTION, { cfg: { autoApprove: false }, conv });
		expect(all.approvals.map((a) => a.caution)).toEqual([UNASKED_WRITE_CAUTION]);
		expect(all.vault.exists(CREATED)).toBe(false);

		// Two writes in one step: the second is not made either once the first was rejected.
		const two = await run([{ tools: [{ tool: "create_note", args: { path: CREATED, content: "# C" } }, { tool: "append_to_note", args: { path: "Daily/2026-06-12.md", text: "- Moved" } }] }, { content: LIST }], QUESTION);
		expect(two.approvals).toHaveLength(1);
		expect(two.vault.exists(CREATED)).toBe(false);
		expect(await two.vault.read("Daily/2026-06-12.md")).toBe(NOTES["Daily/2026-06-12.md"]);
	});

	it("with changes approved one by one the dialog opens as for any change (known: it carries no warning there)", async () => {
		const r = await run([CREATE, { content: LIST }], QUESTION, { cfg: { autoApprove: false } });
		expect(r.approvals).toHaveLength(1);
		expect(r.approvals[0].caution).toBeUndefined();
		expect(r.vault.exists(CREATED)).toBe(false);
	});
});

describe("review: a search or a read that stalls, in a turn that only asked a question", () => {
	it("goes on after two stalls in a row with no tool call between them", async () => {
		const r = await run(
			[
				{ content: "The Capture sections are in the daily notes.\n\nShall I continue reading the other notes?" },
				{ content: "I have not read them yet. Should I read the remaining notes?" },
				{ tools: [{ tool: "read_note", args: { path: "Daily/2026-06-12.md" } }, { tool: "read_note", args: { path: "Daily/2026-07-09.md" } }] },
				{ content: ANSWER },
			],
			QUESTION,
		);
		expect(r.nudges).toEqual([QUESTION_CONTINUE_TEXT, QUESTION_CONTINUE_TEXT]);
		expect(r.saidYes).toBe(false);
		expect(r.tools).toEqual(["read_note", "read_note"]);
		expect(holdsTheAnswer(r.final)).toBe(true);
	});

	it("does not go on a second time when what the model asks again is whether to make the change", async () => {
		for (const again of ["Shall I go ahead?", "Should I proceed with the remaining edits?", "Do you want me to fix the other notes?", "Shall I read the notes and update them?"]) {
			const r = await run([{ content: "I can compile them.\n\nWould you like me to proceed?" }, { content: `${LIST}\n\n${again}` }, { content: "never reached" }], QUESTION);
			expect(r.ollama.requests, again).toHaveLength(2);
			expect(r.nudges, again).toEqual([QUESTION_CONTINUE_TEXT]);
			expect(holdsTheAnswer(r.final), again).toBe(true);
		}
	});

	it("stops after MAX_AUTO_CONTINUES stalls in a row", async () => {
		const stall: Scripted[] = [];
		for (let i = 0; i < MAX_AUTO_CONTINUES + 3; i++) stall.push({ content: "Should I read the remaining notes?" });
		const r = await run(stall, QUESTION);
		expect(r.nudges).toEqual(Array.from({ length: MAX_AUTO_CONTINUES }, () => QUESTION_CONTINUE_TEXT));
		expect(r.ollama.requests).toHaveLength(MAX_AUTO_CONTINUES + 1);
		expect(r.saidYes).toBe(false);
	});

	it("asksToReadOn: a question about reading or searching on, and about nothing else", () => {
		for (const text of ["Should I read the remaining notes?", "Shall I continue reading the other notes?", "Do you want me to check the rest?", "Would you like me to search the other folders?", "Shall I look at the next ten?"]) {
			expect(asksToReadOn(text), text).toBe(true);
		}
		for (const text of [
			"Shall I go ahead?",
			"Would you like me to proceed?",
			"Shall I read the notes and update them?",
			"Would you like me to read the full content of the 8 substantial Capture sections so we can compile them into a single note?",
			"Should I check the remaining notes and fix them?",
			"I read the remaining notes.",
			"Should I read the remaining notes? I can also create an index note.",
		]) {
			expect(asksToReadOn(text), text).toBe(false);
		}
	});
});

describe("review: a turn that asked for a change is answered as before", () => {
	it("a further change the model asks to go on with is answered yes, up to MAX_AUTO_CONTINUES times", async () => {
		const turns: Scripted[] = [CREATE];
		for (let i = 0; i < MAX_AUTO_CONTINUES + 1; i++) turns.push({ content: "Created the note. Shall I also delete the other notes?" });
		const r = await run(turns, REQUEST, { decision: "approve" });
		expect(r.nudges).toEqual(Array.from({ length: MAX_AUTO_CONTINUES }, () => AUTO_CONTINUE_TEXT));
		// Asked for: made without a dialog.
		expect(r.approvals).toHaveLength(0);
		expect(r.vault.exists(CREATED)).toBe(true);
	});

	it("an offer of new work goes to the user, as before", async () => {
		const r = await run([CREATE, { content: "Created [[Summaries/Capture Compilation]]. Would you like me to create an index note as well?" }], REQUEST, { decision: "approve" });
		expect(r.nudges).toEqual([]);
		expect(r.ollama.requests).toHaveLength(2);
	});

	it("the user's yes in the next message makes the change theirs: no warning, the automatic yes as before", async () => {
		const first = await run([{ content: ANSWER }], QUESTION);
		expect(first.nudges).toEqual([]);
		for (const yes of ["Yes, please do.", "yes", "Go ahead.", "Yes, compile them into a new note.", "ok do it"]) {
			expect(asksOnlyAQuestion(yes), yes).toBe(false);
		}
		const second = await run([{ content: "I will compile both.\n\nShall I proceed?" }, CREATE, { content: "Created [[Summaries/Capture Compilation]]." }], "Yes, please do.", { conv: first.conv });
		expect(second.nudges).toEqual([AUTO_CONTINUE_TEXT]);
		expect(second.approvals).toHaveLength(0);
	});
});

describe("review: the prompts of commands and scheduled jobs are requests", () => {
	const daily = processDailyNotesPrompt({ folder: "Daily", heading: "Capture", destination: "Topics", move: true, since: "2026-11-03" });

	it("whatever the instruction typed for 'Edit the selected text' looks like", () => {
		for (const instruction of ["is shorter", "can you make this shorter?", "reads better?", "answers the question: what is the torque?", "is it clearer this way?", "What would a lawyer write?", "list the steps as bullets", "explain it to a child"]) {
			const prompt = editSelectionPrompt("Projects/Robot.md", "The belts are GT2.\nWhy not GT3?", instruction);
			expect(asksOnlyAQuestion(prompt), instruction).toBe(false);
		}
	});

	it("reformat, and the daily-notes job with the date the nightly job adds", () => {
		expect(asksOnlyAQuestion(reformatPrompt("Questions/What is a belt.md", "# What is a belt?\n\nWhy GT2?"))).toBe(false);
		expect(asksOnlyAQuestion(daily)).toBe(false);
	});

	it("a scheduled job whose model stops to ask is answered yes, and its change is made", async () => {
		const r = await run([{ content: "I surveyed the inboxes.\n\nShall I proceed?" }, { tool: "create_note", args: { path: "Topics/Cluster.md", content: "# Cluster\n\n## Sources\n- [[Daily/2026-06-12]]" } }, { content: "Created [[Topics/Cluster]]." }], daily, { decision: "approve" });
		expect(r.nudges).toEqual([AUTO_CONTINUE_TEXT]);
		expect(r.approvals).toHaveLength(0);
		expect(r.vault.exists("Topics/Cluster.md")).toBe(true);
	});

	it("an edit-selection turn whose instruction is typed as a question gets the automatic yes and no warning", async () => {
		const prompt = editSelectionPrompt("Daily/2026-06-12.md", "Cluster commands I keep forgetting: salloc -N 1.", "can you make this shorter?");
		const r = await run([{ content: "I will shorten the passage.\n\nShall I proceed?" }, { tool: "edit_note", args: { path: "Daily/2026-06-12.md", old_text: "Cluster commands I keep forgetting: salloc -N 1.", new_text: "Cluster: salloc -N 1." } }, { content: "Shortened the passage." }], prompt, { decision: "reject" });
		expect(r.nudges).toEqual([AUTO_CONTINUE_TEXT]);
		expect(r.approvals).toHaveLength(0);
		expect(await r.vault.read("Daily/2026-06-12.md")).toContain("Cluster: salloc -N 1.");
	});
});
