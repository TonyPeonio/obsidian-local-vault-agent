import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/chunker";
import { EMBED_FORMAT, SemanticIndex, type IndexData } from "../src/index";
import { dateTerms } from "../src/retrieval";
import { FakeOllama, FakeVault } from "./fakes";

describe("chunk heading paths", () => {
	it("gives a repeated heading the path of the headings above it", () => {
		const chunks = chunkMarkdown("# Algorithms lectures\n\nintro\n\n## 2026-09-10\n\ntopic\n\n### Summary\n\nfirst\n\n## 2026-09-17\n\n### Summary\n\nsecond");
		expect(chunks.map((c) => [c.heading, c.crumb])).toEqual([
			["Algorithms lectures", "Algorithms lectures"],
			["2026-09-10", "2026-09-10"],
			["Summary", "2026-09-10 › Summary"],
			["Summary", "2026-09-17 › Summary"],
		]);
	});

	it("keeps the top-level heading in the path when the note has several of them", () => {
		const chunks = chunkMarkdown("# Part one\n\n## Setup\n\na\n\n# Part two\n\n## Setup\n\nb");
		expect(chunks.map((c) => c.crumb)).toEqual(["Part one › Setup", "Part two › Setup"]);
	});

	it("drops deeper headings from the path when the level comes back up, and ignores headings in code", () => {
		const chunks = chunkMarkdown("## A\n\n### B\n\n#### C\n\nx\n\n### D\n\ny\n\n```\n## not a heading\n```\n\nz\n\n## E\n\nw");
		expect(chunks.map((c) => c.crumb)).toEqual(["A › B › C", "A › D", "E"]);
		expect(chunks.find((c) => c.crumb === "A › D")?.text).toContain("## not a heading");
	});

	it("has an empty path before the first heading", () => {
		expect(chunkMarkdown("just text")[0]).toMatchObject({ heading: "", crumb: "" });
	});
});

describe("dateTerms", () => {
	const now = new Date(2026, 10, 17, 15); // Tuesday 17 November 2026, local time
	it("reads a month and a day, with or without a year, either order", () => {
		expect(dateTerms("What was covered in CSCI 406 on September 10?", now)).toEqual(["2026-09-10"]);
		expect(dateTerms("notes from Sept. 3rd, 2025", now)).toEqual(["2025-09-03"]);
		expect(dateTerms("the 21st of October", now)).toEqual(["2026-10-21"]);
		expect(dateTerms("10 Sep 2026 meeting", now)).toEqual(["2026-09-10"]);
	});

	it("takes the latest such day that is not far in the future", () => {
		expect(dateTerms("what happened on December 20", now)).toEqual(["2026-12-20"]); // five weeks ahead: this year
		expect(dateTerms("what happened on March 3", now)).toEqual(["2026-03-03"]);
		expect(dateTerms("what happened on February 14", new Date(2026, 0, 5))).toEqual(["2026-02-14"]);
		expect(dateTerms("what happened on August 14", new Date(2026, 0, 5))).toEqual(["2025-08-14"]);
	});

	it("reads numeric and ISO dates", () => {
		expect(dateTerms("meeting on 9/10", now)).toEqual(["2026-09-10"]);
		expect(dateTerms("meeting on 25/9/2026", now)).toEqual(["2026-09-25"]);
		expect(dateTerms("see 2026-10-14 and 10/14/26", now)).toEqual(["2026-10-14"]);
		expect(dateTerms("a ratio of 3/4 cup", now)).toEqual(["2026-03-04"]); // a known false reading: it only adds a search term
		expect(dateTerms("version 1/2/3/4", now)).toEqual([]);
	});

	it("reads relative days from today's local date", () => {
		expect(dateTerms("what did I do yesterday", now)).toEqual(["2026-11-16"]);
		expect(dateTerms("today's tasks", now)).toEqual(["2026-11-17"]);
		expect(dateTerms("what did we decide last Tuesday", now)).toEqual(["2026-11-10"]);
		expect(dateTerms("what did we decide on Friday", now)).toEqual(["2026-11-13"]);
		expect(dateTerms("notes from this week", now)).toEqual(["2026-11-16", "2026-11-17"]);
		expect(dateTerms("notes from last week", now)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
		expect(dateTerms("the last 3 days", now)).toEqual(["2026-11-17", "2026-11-16", "2026-11-15"]);
	});

	it("finds nothing in a question without a day, and never invents an impossible date", () => {
		expect(dateTerms("why did the chess robot move to 24V", now)).toEqual([]);
		expect(dateTerms("may 5 people come", now)).toEqual(["2026-05-05"]); // "may" is a month: one extra search term, no harm
		expect(dateTerms("February 31", now)).toEqual([]);
		expect(dateTerms("march of the penguins", now)).toEqual([]);
	});
});

class MemoryStore {
	data: IndexData | null = null;
	async load() {
		return this.data;
	}
	async save(d: IndexData) {
		this.data = JSON.parse(JSON.stringify(d)) as IndexData;
	}
}

const LECTURES = [
	"# Algorithms lectures",
	"",
	"## 2026-09-03",
	"",
	"**Topic:** Asymptotic notation. The key idea was the master theorem.",
	"",
	"### Summary",
	"",
	"- Recurrences and the master theorem.",
	"",
	"## 2026-09-10",
	"",
	"**Topic:** Divide and conquer. The key idea was Strassen.",
	"",
	"### Summary",
	"",
	"- Seven multiplications instead of eight.",
].join("\n");

function setup(notes: Record<string, string>, store = new MemoryStore()) {
	const vault = new FakeVault(notes);
	const ollama = new FakeOllama([], 64);
	const index = new SemanticIndex(ollama.asClient(), vault, store, {
		getModel: () => "nomic-embed-text",
		isEnabled: () => true,
		shouldIndex: () => true,
		now: () => new Date(2026, 10, 17, 12),
	});
	return { vault, ollama, store, index };
}

describe("passage search by meaning and by words", () => {
	const notes = {
		"School/Lectures - CSCI 406.md": LECTURES,
		"Projects/Hall Sensors.md": "# Hall Sensors\n\nA3144 digital hall sensors under each square, read at 50 Hz.",
		"Daily/2026-09-10.md": "Went for a run. Bought groceries.",
		"Recipes/Pasta.md": "Boil water, add pasta, stir for nine minutes.",
		"Ideas/Robots.md": "A robot arm for sorting bricks by colour and size.",
	};

	it("shows the heading path, embeds it, and says how many of the question's words a passage has", async () => {
		const { index, ollama } = setup(notes);
		await index.syncAll();
		expect(ollama.embedCalls.flat()).toContain("search_document: Lectures - CSCI 406 > 2026-09-10 › Summary\n- Seven multiplications instead of eight.");
		const hits = await index.searchPassages("seven multiplications", 3);
		expect(hits[0]).toMatchObject({ path: "School/Lectures - CSCI 406.md", heading: "Summary", crumb: "2026-09-10 › Summary", words: { matched: 2, terms: 2 } });
	});

	it("finds an identifier by its exact word where the embedding alone does not", async () => {
		const { index } = setup(notes);
		await index.syncAll();
		expect((await index.searchPassages("A3144", 1))[0].path).toBe("Projects/Hall Sensors.md");
	});

	it("puts the sections and notes dated the day a question names first, the one with the question's words on top", async () => {
		const { index } = setup(notes);
		await index.syncAll();
		const hits = await index.searchPassages("What was covered in CSCI 406 on September 10?", 6);
		// The lecture section headed by that day, in the note the question names, before anything else.
		expect(hits[0]).toMatchObject({ path: "School/Lectures - CSCI 406.md" });
		expect(hits[0].crumb?.startsWith("2026-09-10")).toBe(true);
		// The daily note of that day is dated by its name, and is among the dated results.
		expect(hits.slice(0, 4).map((h) => h.path)).toContain("Daily/2026-09-10.md");
		// Places are left for the best of everything else: the other notes are still there.
		expect(hits.some((h) => !h.path.includes("2026-09-10") && !(h.crumb ?? "").includes("2026-09-10"))).toBe(true);
		const without = await index.searchPassages("What was covered in CSCI 406 on September 10?", 6, 3, undefined, { dates: false });
		expect(without.length).toBe(hits.length);
	});

	it("ranks the passages of a day by the question's words, not by meaning", async () => {
		const { index } = setup({
			"Daily/2026-10-21.md": ["# 2026-10-21", "Mood: ok.", "## Done", "- Implemented re-homing every 50 moves.", "## Tomorrow", "- [ ] Laundry"].join("\n\n"),
			"Daily/2026-10-22.md": ["# 2026-10-22", "## Done", "- Bought parts."].join("\n\n"),
			"Projects/Robot.md": "What did I get done: a list of what I get done on any day.",
		});
		await index.syncAll();
		const hits = await index.searchPassages("What did I get done on October 21?", 4);
		expect(hits[0]).toMatchObject({ path: "Daily/2026-10-21.md", heading: "Done" });
	});

	it("still answers with embeddings only when asked to, and honours the per-note limit in both modes", async () => {
		const { index } = setup(notes);
		await index.syncAll();
		for (const opts of [{ lexical: false }, {}, { fusion: "rrf" as const }]) {
			const hits = await index.searchPassages("master theorem recurrences Strassen multiplications", 10, 2, undefined, opts);
			expect(hits.filter((h) => h.path === "School/Lectures - CSCI 406.md").length).toBeLessThanOrEqual(2);
			expect(new Set(hits.map((h) => `${h.path}#${h.crumb}#${h.text}`)).size).toBe(hits.length);
		}
	});

	it("follows edits, renames and deletions in the word index too", async () => {
		const { index, vault } = setup(notes);
		await index.syncAll();
		await vault.modify("Projects/Hall Sensors.md", "# Hall Sensors\n\nNow using DRV5032 sensors.");
		await index.syncAll();
		expect((await index.searchPassages("DRV5032", 1))[0].path).toBe("Projects/Hall Sensors.md");
		expect((await index.searchPassages("A3144", 5)).every((h) => !h.words)).toBe(true);
		index.rename("Projects/Hall Sensors.md", "Projects/Sensors.md");
		expect((await index.searchPassages("DRV5032", 1))[0].path).toBe("Projects/Sensors.md");
		index.remove("Projects/Sensors.md");
		expect((await index.searchPassages("DRV5032", 5)).every((h) => h.path !== "Projects/Sensors.md")).toBe(true);
	});
});

describe("the word index is built on the first search", () => {
	it("is not built by indexing or loading, and catches up with notes that change while it is being built", async () => {
		const notes: Record<string, string> = {};
		for (let i = 0; i < 900; i++) notes[`N/${String(i).padStart(3, "0")}.md`] = `note number ${i} about topic${i}`;
		const { index, vault } = setup(notes);
		await index.syncAll();
		// Nothing has searched yet: no word is called absent on the strength of an index that does not exist.
		expect(index.absentWords("zebras")).toEqual([]);
		// The build yields between slices; an edit, a new note and a removal land in the middle of it.
		const first = index.searchPassages("topic777", 3);
		await vault.modify("N/001.md", "now about marmots");
		vault.seed("N/new.md", "a late note about capybaras");
		const sync = index.syncAll();
		index.remove("N/002.md");
		const hits = await first;
		await sync;
		expect(hits[0].path).toBe("N/777.md");
		expect((await index.searchPassages("marmots", 1))[0].path).toBe("N/001.md");
		expect((await index.searchPassages("capybaras", 1))[0].path).toBe("N/new.md");
		expect((await index.searchPassages("topic2", 3)).every((h) => h.path !== "N/002.md")).toBe(true);
		expect(index.absentWords("zebras and marmots")).toEqual(["zebras"]);
	});
});

describe("an index saved before heading paths", () => {
	it("is searchable at once, chunked again on the next sync, and only sections whose path changed are embedded again", async () => {
		const first = setup({ "School/Lectures - CSCI 406.md": LECTURES });
		await first.index.syncAll();
		await first.index.flush();
		// What 0.8.0 wrote: no format marker, no paths.
		const old = JSON.parse(JSON.stringify(first.store.data)) as IndexData;
		for (const f of Object.values(old.files)) {
			delete f.fmt;
			for (const c of f.chunks) delete c.crumb;
		}
		const store = new MemoryStore();
		store.data = old;
		const { index, ollama } = setup({ "School/Lectures - CSCI 406.md": LECTURES }, store);
		await index.load();
		expect(index.ready).toBe(true);
		expect((await index.searchPassages("master theorem", 1))[0].path).toBe("School/Lectures - CSCI 406.md");
		ollama.embedCalls.length = 0;
		await index.syncAll();
		// The two "Summary" sections now carry their date; the sections directly under a date and the title did not change.
		const sent = ollama.embedCalls.flat().filter((i) => i.startsWith("search_document: "));
		expect(sent).toHaveLength(2);
		expect(sent.every((i) => i.includes(" › Summary"))).toBe(true);
		await index.flush();
		expect(store.data?.files["School/Lectures - CSCI 406.md"].fmt).toBe(EMBED_FORMAT);
		// A second sync has nothing left to do.
		ollama.embedCalls.length = 0;
		await index.syncAll();
		expect(ollama.embedCalls.flat().filter((i) => i.startsWith("search_document: "))).toHaveLength(0);
	});
});
