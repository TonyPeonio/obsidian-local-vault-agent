import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/chunker";
import { EMBED_FORMAT, SemanticIndex, UNREAD_CHECK_CHARS, UNREAD_CHECK_NOTES, type IndexData } from "../src/index";
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

	it("ranks notes by their best passage, with its heading path and the words nearest the question", async () => {
		const { index } = setup(notes);
		await index.syncAll();
		const hits = await index.searchNotes("seven multiplications", 3);
		expect(hits[0]).toMatchObject({ path: "School/Lectures - CSCI 406.md", heading: "2026-09-10 › Summary" });
		expect(hits[0].snippet).toContain("Seven multiplications instead of eight");
		// One entry per note.
		expect(new Set(hits.map((h) => h.path)).size).toBe(hits.length);
		expect((await index.searchNotes("A3144", 1))[0].path).toBe("Projects/Hall Sensors.md");
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
		expect(await index.absentWords("zebras")).toEqual([]);
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
		expect(await index.absentWords("zebras and marmots")).toEqual(["zebras"]);
	});
});

describe("a word is called absent only when the vault as it is now does not have it", () => {
	const notes = {
		"Projects/Chess Robot.md": "# Chess Robot\n\nSwitch the gantry supply to 24V.",
		"Recipes/Pasta.md": "Boil water, add pasta, stir for nine minutes.",
	};
	const QUESTION = "What about the belts?";
	const LOG = "# Robot club log\n\n## 2026-08-18\n\n- **Decision:** replace the GT2 belts with GT3 on both axes.";
	/** An index that has read `notes` and built its word index. */
	const built = async (store = new MemoryStore()) => {
		const s = setup(notes, store);
		await s.index.syncAll();
		await s.index.searchPassages("gantry", 1);
		return s;
	};
	/** A vault whose reads are counted. */
	const countReads = (vault: FakeVault): string[] => {
		const reads: string[] = [];
		const read = vault.read.bind(vault);
		vault.read = async (path: string) => {
			reads.push(path);
			return read(path);
		};
		return reads;
	};

	it("reads a note created after indexing before saying no note has the word (the benchmark's long-note failure)", async () => {
		const { index, vault } = await built();
		expect(await index.absentWords(QUESTION)).toEqual(["belts"]);
		// The note is planted and the vault's event reaches the index at once; indexing waits for the pause.
		vault.seed("Clubs/Robot club log 2026.md", LOG);
		index.touch("Clubs/Robot club log 2026.md");
		expect(index.unreadCount).toBe(1);
		expect(await index.absentWords(QUESTION)).toEqual([]);
		// A word neither the index nor the new note has is still named.
		expect(await index.absentWords("What about the belts and the wheels?")).toEqual(["wheels"]);
		// Once the note is indexed (the pause is over), the word index answers alone.
		const reads = countReads(vault);
		index.enqueue("Clubs/Robot club log 2026.md");
		await index.idle();
		expect(index.unreadCount).toBe(0);
		reads.length = 0;
		expect(await index.absentWords(QUESTION)).toEqual([]);
		expect(await index.absentWords("the wheels")).toEqual(["wheels"]);
		expect(reads).toEqual([]);
	});

	it("reads a note edited after indexing, and one the index knows under an older name", async () => {
		const { index, vault } = await built();
		await vault.modify("Recipes/Pasta.md", "Boil water. The mixer's belts squeak.");
		index.touch("Recipes/Pasta.md");
		expect(await index.absentWords(QUESTION)).toEqual([]);
		// Renamed before it was indexed again: still unread under the new name.
		await vault.rename("Recipes/Pasta.md", "Recipes/Mixer.md");
		index.rename("Recipes/Pasta.md", "Recipes/Mixer.md");
		expect(index.unreadCount).toBe(1);
		expect(await index.absentWords(QUESTION)).toEqual([]);
		// The rename itself has it read: the pause after the edit ends with the old name, which no longer exists.
		index.enqueue("Recipes/Pasta.md");
		await index.idle();
		expect(index.unreadCount).toBe(0);
		expect((await index.searchPassages("mixer belts squeak", 1))[0]).toMatchObject({ path: "Recipes/Mixer.md", text: "Boil water. The mixer's belts squeak." });
		// Edited so that the word is gone: nothing is said of it while the index still has the old text, and it is named once the note is read.
		await vault.modify("Recipes/Mixer.md", "Boil water. The mixer squeaks.");
		index.touch("Recipes/Mixer.md");
		expect(await index.absentWords(QUESTION)).toEqual([]);
		index.enqueue("Recipes/Mixer.md");
		await index.idle();
		expect(await index.absentWords(QUESTION)).toEqual(["belts"]);
		await vault.modify("Recipes/Mixer.md", "Boil water. The mixer's belts squeak.");
		index.touch("Recipes/Mixer.md");
		expect(await index.absentWords(QUESTION)).toEqual([]);
		// Deleted: the note and its word are gone.
		await vault.trash("Recipes/Mixer.md");
		index.remove("Recipes/Mixer.md");
		expect(index.unreadCount).toBe(0);
		expect(await index.absentWords(QUESTION)).toEqual(["belts"]);
	});

	it("reads only the notes that are out of date, and none when the index has the word", async () => {
		const { index, vault } = await built();
		const reads = countReads(vault);
		vault.seed("Inbox/Zebras.md", "nothing of interest");
		index.touch("Inbox/Zebras.md");
		expect(await index.absentWords("the gantry supply")).toEqual([]);
		expect(reads).toEqual([]);
		expect(await index.absentWords(QUESTION)).toEqual(["belts"]);
		expect(reads).toEqual(["Inbox/Zebras.md"]);
		// A word only the unread note's name has is in the vault too.
		expect(await index.absentWords("the zebras")).toEqual([]);
	});

	it("keeps a note unread when the embedding server does not answer, and when it changes while being indexed", async () => {
		const { index, vault, ollama } = await built();
		const embed = ollama.embed.bind(ollama);
		// The server is down: the note is taken from the queue and not indexed.
		ollama.embed = async () => {
			throw new Error("connection refused");
		};
		vault.seed("Clubs/Log.md", LOG);
		index.touch("Clubs/Log.md");
		index.enqueue("Clubs/Log.md");
		await index.idle();
		expect(index.status()).toMatchObject({ pending: 0, lastError: "connection refused" });
		expect(index.unreadCount).toBe(1);
		// The queries need no document embedding: the word check still reads the note.
		expect(await index.absentWords(QUESTION)).toEqual([]);
		// The server is back, and the note is edited while its older text is being embedded.
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		ollama.embed = async (model: string, inputs: string[]) => {
			if (inputs.some((i) => i.startsWith("search_document"))) await held;
			return embed(model, inputs);
		};
		await vault.modify("Clubs/Log.md", "# Robot club log\n\nNo decisions yet.");
		index.touch("Clubs/Log.md");
		const sync = index.syncAll();
		await Promise.resolve();
		await vault.modify("Clubs/Log.md", LOG);
		index.touch("Clubs/Log.md");
		release();
		await sync;
		// The index holds "No decisions yet"; the note says belts, and is still marked unread.
		expect(index.unreadCount).toBe(1);
		expect(await index.absentWords(QUESTION)).toEqual([]);
		index.enqueue("Clubs/Log.md");
		await index.idle();
		expect(index.unreadCount).toBe(0);
		expect(await index.absentWords(QUESTION)).toEqual([]);
	});

	it("says nothing when more is unread than is cheap to read, or the index was never compared with the vault", async () => {
		const store = new MemoryStore();
		const first = await built(store);
		await first.index.flush();
		expect(await first.index.absentWords(QUESTION)).toEqual(["belts"]);
		// Many notes arrive at once (a sync from another device, an import): too many to read for one sentence.
		const reads = countReads(first.vault);
		for (let i = 0; i <= UNREAD_CHECK_NOTES; i++) {
			first.vault.seed(`Import/${i}.md`, `imported note ${i}`);
			first.index.touch(`Import/${i}.md`);
		}
		expect(first.index.unreadCount).toBe(UNREAD_CHECK_NOTES + 1);
		expect(await first.index.absentWords(QUESTION)).toEqual([]);
		expect(reads).toEqual([]);
		// One note too large to read for it.
		const big = await built();
		big.vault.seed("Dump.md", "x ".repeat(UNREAD_CHECK_CHARS / 2 + 1));
		big.index.touch("Dump.md");
		expect(await big.index.absentWords(QUESTION)).toEqual([]);
		// Loaded from disk, searched, but not yet compared with the vault: a note made while the app was closed is unknown.
		const later = setup({ ...notes, "Clubs/Log.md": LOG }, store);
		await later.index.load();
		await later.index.searchPassages("gantry", 1);
		expect(await later.index.absentWords(QUESTION)).toEqual([]);
		// Compared: the new note is queued, indexed, and the index has the word itself.
		await later.index.syncAll();
		expect(later.index.unreadCount).toBe(0);
		expect(await later.index.absentWords(QUESTION)).toEqual([]);
		expect(await later.index.absentWords("the wheels")).toEqual(["wheels"]);
	});

	it("does not read a note that is not indexed by choice, and says nothing once that choice changes until the next sync", async () => {
		const vault = new FakeVault(notes);
		let excluded = "Private/";
		const index = new SemanticIndex(new FakeOllama([], 64).asClient(), vault, new MemoryStore(), { getModel: () => "nomic-embed-text", isEnabled: () => true, shouldIndex: (p) => !p.startsWith(excluded) });
		await index.syncAll();
		await index.searchPassages("gantry", 1);
		vault.seed("Private/Diary.md", "the belts");
		index.touch("Private/Diary.md");
		expect(index.unreadCount).toBe(0);
		expect(await index.absentWords(QUESTION)).toEqual(["belts"]);
		// The folder is no longer excluded: its notes are in view, and the index has not read them.
		excluded = "Nothing/";
		index.scopeChanged();
		expect(await index.absentWords(QUESTION)).toEqual([]);
		expect(await index.absentWords("the wheels")).toEqual([]);
		await index.syncAll();
		expect(await index.absentWords(QUESTION)).toEqual([]);
		expect(await index.absentWords("the wheels")).toEqual(["wheels"]);
	});

	it("counts the words a note has only in its properties, in its name, or in a heading with nothing under it", async () => {
		const store = new MemoryStore();
		const { index, vault } = setup(
			{
				...notes,
				"Projects/Greenhouse Monitor.md": "---\nstatus: paused\nowner: Lena\n---\n# Greenhouse Monitor\n\nWaiting on the humidity sensors.\n",
				"Projects/Desk Clock.md": "---\nstatus: paused\nowner: Jordan\n---\n# Desk Clock\n\nOn hold.\n",
				// A lone title with only sections below it, and a section with no text: the chunker puts neither in a chunk.
				"Daily/2026-09-10.md": "# Wheels day\n\n## Morning\n\nOrdered parts.\n\n## Flywheel\n\n## Evening\n\nNothing.",
				"Inbox/Zeppelin.md": "",
			},
			store,
		);
		await index.syncAll();
		await index.searchPassages("gantry", 1);
		expect(index.unreadCount).toBe(0);
		expect(await index.absentWords("paused and Lena and Jordan")).toEqual([]);
		expect(await index.absentWords("the wheels and the flywheel and the zeppelin")).toEqual([]);
		expect(await index.absentWords("the paused turbines")).toEqual(["turbines"]);
		// The words go when the property, the name and the note do.
		await vault.modify("Projects/Greenhouse Monitor.md", "# Greenhouse Monitor\n\nWaiting on the humidity sensors.\n");
		await index.syncAll();
		expect(await index.absentWords("paused and Lena and Jordan")).toEqual(["lena"]);
		await vault.rename("Inbox/Zeppelin.md", "Inbox/Airship.md");
		index.rename("Inbox/Zeppelin.md", "Inbox/Airship.md");
		expect(await index.absentWords("the zeppelin and the airship")).toEqual(["zeppelin"]);
		await vault.trash("Daily/2026-09-10.md");
		index.remove("Daily/2026-09-10.md");
		expect(await index.absentWords("the wheels and the flywheel")).toEqual(["wheels", "flywheel"]);

		// Saved and loaded again, the index still has those words, and reads and embeds nothing for them.
		await index.flush();
		const reads = countReads(vault);
		const reopen = async () => {
			const ollama = new FakeOllama([], 64);
			const next = new SemanticIndex(ollama.asClient(), vault, store, { getModel: () => "nomic-embed-text", isEnabled: () => true, shouldIndex: () => true });
			await next.load();
			await next.syncAll();
			await next.searchPassages("gantry", 1);
			return { next, embedded: ollama.embedCalls.flat().filter((i) => i.startsWith("search_document: ")).length };
		};
		const kept = await reopen();
		expect(reads).toEqual([]);
		expect(kept.embedded).toBe(0);
		expect(await kept.next.absentWords("Jordan and the airship and the turbines")).toEqual(["turbines"]);
		// An entry saved before these words were kept: the note is read again on the next sync, and nothing is embedded for it.
		await kept.next.flush();
		for (const f of Object.values(store.data!.files)) delete f.rest;
		const older = await reopen();
		expect(reads.sort()).toEqual(vault.listNotes().map((n) => n.path).sort());
		expect(older.embedded).toBe(0);
		expect(await older.next.absentWords("Jordan and the airship and the turbines")).toEqual(["turbines"]);
	});

	it("costs one question no read on a vault of 50,000 notes with 5,000 not yet indexed, and at most 100 reads when few are", async () => {
		// Every note has a word of its own, so the word list is as long as a real vault's of this size.
		const own = (i: number) => "x" + Array.from(String(i), (d) => "abcdefghij"[Number(d)]).join("");
		const text = (i: number) => `Note ${i} about subject${i} and the ${own(i)} of it.`;
		const vault = new FakeVault();
		for (let i = 0; i < 45_000; i++) vault.seed(`Notes/${i}.md`, text(i));
		const index = new SemanticIndex(new FakeOllama([], 16).asClient(), vault, { load: async () => null, save: async () => {} }, { getModel: () => "nomic-embed-text", isEnabled: () => true, shouldIndex: () => true });
		await index.syncAll();
		expect(index.status().indexedFiles).toBe(45_000);
		await index.searchPassages("subject777", 4);
		const timed = async <T>(run: () => Promise<T>): Promise<[T, number]> => {
			const start = performance.now();
			const result = await run();
			return [result, performance.now() - start];
		};
		const ASK = "What did we decide about the zeppelins?";
		const [, baseMs] = await timed(() => index.absentWords(ASK));

		// 5,000 notes arrive at once (an import, a sync from another device): the vault's events reach the index, the embedding has not happened.
		for (let i = 45_000; i < 50_000; i++) {
			vault.seed(`Notes/${i}.md`, text(i));
			index.touch(`Notes/${i}.md`);
		}
		expect(index.unreadCount).toBe(5_000);
		const reads = countReads(vault);
		const [, searchMs] = await timed(() => index.searchPassages(ASK, 4));
		const [many, manyMs] = await timed(() => index.absentWords(ASK));
		// Too many to read for one sentence: nothing is read, and nothing is said.
		expect(many).toEqual([]);
		expect(reads).toEqual([]);
		expect(manyMs).toBeLessThan(1000);

		// They are indexed; then 100 long notes are edited, which is the most the check reads (1.9 of its 2 million characters).
		for (let i = 45_000; i < 50_000; i++) index.enqueue(`Notes/${i}.md`);
		await index.idle();
		expect(index.unreadCount).toBe(0);
		const long = "Reviewed the action items from last time; nothing blocking. ".repeat(322);
		for (let i = 0; i < UNREAD_CHECK_NOTES; i++) {
			await vault.modify(`Notes/${i}.md`, long);
			index.touch(`Notes/${i}.md`);
		}
		reads.length = 0;
		const [few, fewMs] = await timed(() => index.absentWords(ASK));
		expect(few).toEqual(["decide", "zeppelins"]);
		expect(reads).toHaveLength(UNREAD_CHECK_NOTES);
		expect(fewMs).toBeLessThan(10_000);
		// The number this test is for; the bounds above are loose because the machine may be busy.
		console.log(`absent-word check at 50,000 notes: ${baseMs.toFixed(1)} ms with nothing unread, ${manyMs.toFixed(1)} ms and 0 reads with 5,000 unread, ${fewMs.toFixed(1)} ms and ${reads.length} reads (${(long.length * UNREAD_CHECK_NOTES).toLocaleString("en-US")} characters) with 100 unread; the passage search of the same question took ${searchMs.toFixed(1)} ms`);
	}, 120_000);
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
