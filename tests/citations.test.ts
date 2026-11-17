import { describe, expect, it } from "vitest";
import { Agent, newConversation, type AgentConfig } from "../src/agent";
import { addBlockIds, blockIdEdits, blockIds, linkedTargets, matchPassages, newBlockId, paragraphs, passageLink, planCitations, timestampSeconds, withPassages } from "../src/citations";
import { keywordSearch } from "../src/search";
import { ALL_TOOLS } from "../src/tools";
import type { ApprovalRequest } from "../src/types";
import { UndoStack } from "../src/undo";
import { FakeOllama, FakeVault } from "./fakes";

const LECTURE = [
	"---",
	"course: CSCI 470",
	"---",
	"# Isolation forests",
	"",
	"## Summary",
	"",
	"- Contamination sets the expected share of outliers [12:05]",
	"- Trees isolate points by random splits [3:10]",
	"",
	"## Transcript",
	"",
	"**[3:10]** So each tree keeps splitting on a random feature until a point is alone.",
	"",
	"**[12:05]** The contamination parameter defaults to 0.05 here, meaning we expect five percent outliers.",
	"",
	"**[13:40]** Questions about the homework go to office hours. ^existing",
	"",
	"```python",
	"model = IsolationForest(contamination=0.05)",
	"```",
].join("\n");

describe("paragraphs", () => {
	it("splits text into paragraphs with heading, block id and timestamp; skips frontmatter, headings and code", () => {
		const ps = paragraphs(LECTURE);
		expect(ps.map((p) => p.heading)).toEqual(["Summary", "Summary", "Transcript", "Transcript", "Transcript"]);
		expect(ps[0].text).toBe("- Contamination sets the expected share of outliers [12:05]");
		expect(ps[3].timestamp).toBe("12:05");
		expect(ps[3].start).toBe(14);
		expect(ps[4].blockId).toBe("existing");
		expect(ps[4].text).toBe("**[13:40]** Questions about the homework go to office hours.");
		expect(ps.some((p) => p.text.includes("IsolationForest("))).toBe(false);
	});

	it("handles CRLF line endings and multi-line paragraphs", () => {
		const ps = paragraphs("# A\r\nline one\r\nline two\r\n\r\nnext\r\n");
		expect(ps).toHaveLength(2);
		expect(ps[0]).toMatchObject({ start: 1, end: 2, text: "line one\nline two" });
	});
});

describe("matchPassages", () => {
	it("finds a paragraph quoted word for word", () => {
		const hits = matchPassages('The professor said "the contamination parameter defaults to 0.05 here".', LECTURE);
		expect(hits.map((h) => h.timestamp)).toEqual(["12:05"]);
	});

	it("finds a transcript paragraph by the timestamp the answer names", () => {
		const hits = matchPassages("At 3:10 he explains how trees split.", LECTURE);
		expect(hits.map((h) => h.timestamp)).toContain("3:10");
	});

	it("finds a paraphrase that shares most content words, and nothing for an unrelated answer", () => {
		const hits = matchPassages("Each tree keeps splitting on a random feature until the point stands alone.", LECTURE);
		expect(hits[0].timestamp).toBe("3:10");
		expect(matchPassages("Pasta needs salted water and patience.", LECTURE)).toEqual([]);
	});
});

describe("block ids", () => {
	it("makes ids from timestamps or a text hash, unique in the note", () => {
		const ps = paragraphs(LECTURE);
		const taken = blockIds(LECTURE);
		expect(taken.has("existing")).toBe(true);
		expect(newBlockId(ps[3], taken)).toBe("t12-05");
		expect(newBlockId(ps[3], taken)).toBe("t12-05-2");
		expect(newBlockId(ps[0], new Set())).toMatch(/^c[0-9a-z]{6}$/);
		expect(timestampSeconds("1:02:03")).toBe(3723);
	});

	it("appends ids to the last line of each paragraph, keeping CRLF", () => {
		expect(addBlockIds("a\nb\n\nc", [{ end: 1, id: "x" }])).toBe("a\nb ^x\n\nc");
		expect(addBlockIds("a\r\nb\r\n", [{ end: 0, id: "y" }])).toBe("a ^y\r\nb\r\n");
	});

	it("links by id, else by heading, with the time or heading as the alias", () => {
		const ps = paragraphs(LECTURE);
		expect(passageLink("Courses/ML/2026-10-02.md", ps[3], "t12-05")).toBe("[[Courses/ML/2026-10-02#^t12-05|2026-10-02 › 12:05]]");
		expect(passageLink("Courses/ML/2026-10-02.md", ps[3], null)).toBe("[[Courses/ML/2026-10-02#Transcript|2026-10-02 › 12:05]]");
		expect(passageLink("N.md", { ...ps[0], heading: "A [b] #c", timestamp: null }, null)).toBe("[[N#A b c|N › A b c]]");
	});
});

describe("planCitations / withPassages", () => {
	it("reuses existing ids, proposes new ones, and falls back to headings when not written", () => {
		const answer = 'He said "the contamination parameter defaults to 0.05 here" and "Questions about the homework go to office hours".';
		const cites = planCitations(answer, [{ path: "L.md", content: LECTURE }]);
		expect(cites.map((c) => [c.id, c.isNew])).toEqual([
			["t12-05", true],
			["existing", false],
		]);
		const edits = blockIdEdits(cites, new Map([["L.md", LECTURE]]));
		expect(edits.get("L.md")).toContain("meaning we expect five percent outliers. ^t12-05");
		expect(withPassages(answer, cites, new Set(["L.md"]))).toContain("Passages: [[L#^t12-05|L › 12:05]], [[L#^existing|L › 13:40]]");
		expect(withPassages(answer, cites, new Set())).toContain("Passages: [[L#Transcript|L › 12:05]], [[L#^existing|L › 13:40]]");
	});

	it("lists linked note targets without subpaths, embeds or code", () => {
		expect(linkedTargets("See [[A]], [[B#H|b]], ![[pic.png]] and `[[C]]`, again [[A]].")).toEqual(["A", "B"]);
	});
});

const config: AgentConfig = {
	model: "fake",
	numCtx: 8192,
	temperature: 0,
	keepAlive: "1m",
	maxIterations: 6,
	maxToolResultChars: 4000,
	autoApprove: false,
	autoContinue: false,
	extraSystemPrompt: "",
};

describe("agent paragraph citations", () => {
	async function run(decision: "approve" | "reject", mode: AgentConfig["citations"] = "blocks") {
		const vault = new FakeVault({ "Courses/ML/2026-10-02.md": LECTURE });
		const undo = new UndoStack();
		const asked: ApprovalRequest[] = [];
		const ollama = new FakeOllama([
			{ tool: "read_note", args: { path: "Courses/ML/2026-10-02" } },
			{ content: 'At 12:05 the professor said "The contamination parameter defaults to 0.05 here" ([[Courses/ML/2026-10-02]]).' },
		]);
		const agent = new Agent({
			client: ollama.asClient(),
			vault,
			tools: ALL_TOOLS,
			search: (q, l) => keywordSearch(vault, q, l),
			approve: async (req) => {
				asked.push(req);
				return decision;
			},
			getConfig: () => ({ ...config, citations: mode }),
			undo,
		});
		let final = "";
		await agent.run(newConversation(), "What did the professor say about contamination?", { onAssistantDone: (m) => (final = m.content) });
		return { vault, undo, asked, final };
	}

	it("adds the block id on approval, records it for undo, and links the paragraph", async () => {
		const { vault, undo, asked, final } = await run("approve");
		expect(asked).toHaveLength(1);
		expect(asked[0].tool).toBe("add_block_ids");
		expect(await vault.read("Courses/ML/2026-10-02.md")).toContain("five percent outliers. ^t12-05");
		expect(final).toContain("Passages: [[Courses/ML/2026-10-02#^t12-05|2026-10-02 › 12:05]]");
		expect(undo.list().map((c) => c.tool)).toEqual(["add_block_ids"]);
	});

	it("writes nothing on rejection and links the heading instead", async () => {
		const { vault, undo, final } = await run("reject");
		expect(await vault.read("Courses/ML/2026-10-02.md")).toBe(LECTURE);
		expect(final).toContain("Passages: [[Courses/ML/2026-10-02#Transcript|2026-10-02 › 12:05]]");
		// A rejected id is not a rejected change: no rejection question is added.
		expect(final).not.toContain("What would you like me to do instead");
		expect(undo.size).toBe(0);
	});

	it("never asks in headings mode, and adds nothing when off", async () => {
		const headings = await run("approve", "headings");
		expect(headings.asked).toHaveLength(0);
		expect(headings.final).toContain("#Transcript|");
		const off = await run("approve", "off");
		expect(off.final).not.toContain("Passages:");
	});
});
