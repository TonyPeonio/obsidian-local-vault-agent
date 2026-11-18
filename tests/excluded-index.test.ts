import { describe, expect, it } from "vitest";
import { SemanticIndex, type IndexData } from "../src/index";
import { isExcluded } from "../src/settings";
import { searchNotes, searchPassages } from "../src/tools";
import type { ToolContext } from "../src/types";
import { FakeOllama, FakeVault } from "./fakes";

/**
 * A folder added to the excluded folders while the plugin runs. Its notes were indexed before, and
 * the index is only compared with the vault again by the next full sync: until then nothing of
 * theirs may reach the model, through no search and no statement about the vault's words.
 * "zanzibar" and "quokka" are words only the private notes have.
 */
function setup() {
	const excluded: string[] = [];
	const all = new FakeVault({
		"Notes/Trip.md": "# Trip\n\nThe ferry to the island leaves at nine and the tickets are in the blue folder.",
		"Notes/Garden.md": "# Garden\n\nTomatoes go in after the last frost.",
		"Private/Diary.md": "# Diary\n\nThe ferry to zanzibar leaves at nine. I have told nobody about the island trip.\n\n## Money\n\nThe quokka fund holds 4,000.",
		"Private/Deep/Letter.md": "# Letter\n\nA letter about the island ferry and zanzibar that was never sent.",
	});
	// The vault the plugin's tools see lists nothing from an excluded folder (ObsidianVault does the same).
	const vault = Object.assign(Object.create(all) as FakeVault, {
		listNotes: () => all.listNotes().filter((n) => !isExcluded(n.path, excluded)),
		exists: (p: string) => all.exists(p) && !isExcluded(p, excluded),
	});
	let saved: IndexData | null = null;
	const index = new SemanticIndex(new FakeOllama([]).asClient(), vault, { load: async () => saved, save: async (d) => void (saved = d) }, {
		getModel: () => "nomic-embed-text",
		isEnabled: () => true,
		shouldIndex: (p) => p.endsWith(".md") && !isExcluded(p, excluded),
	});
	// What the settings tab does when the excluded folders are edited.
	const exclude = (folder: string) => {
		excluded.push(folder);
		index.scopeChanged();
	};
	// The search providers the plugin gives the agent (src/main.ts).
	const ctx = {
		vault,
		search: (q: string, limit: number) => index.searchNotes(q, limit),
		searchPassages: (q: string, limit: number) => index.searchPassages(q, limit),
		absentWords: (q: string) => index.absentWords(q),
		maxResultChars: 12000,
	} as unknown as ToolContext;
	const include = () => {
		excluded.length = 0;
		index.scopeChanged();
	};
	return { index, exclude, include, excluded, ctx, saved: () => saved };
}

const QUESTION = "When does the ferry to zanzibar leave for the island trip?";
const leaks = (text: string) => /Private|Diary|Letter|zanzibar leaves|quokka|told nobody|never sent/i.test(text);

describe("a folder excluded while its notes are in the index", () => {
	it("is in the index before it is excluded (the test would prove nothing otherwise)", async () => {
		const { index, ctx } = setup();
		await index.syncAll();
		expect((await index.searchPassages(QUESTION, 6)).some((p) => p.path === "Private/Diary.md")).toBe(true);
		expect(leaks(await searchPassages.execute({ query: QUESTION }, ctx))).toBe(true);
	});

	it("gives no passage and no note name to any search from the moment the setting changes, before any sync", async () => {
		const { index, exclude, ctx } = setup();
		await index.syncAll();
		exclude("Private");
		const passages = await index.searchPassages(QUESTION, 20);
		expect(passages.map((p) => p.path).filter((p) => p.startsWith("Private/"))).toEqual([]);
		expect(passages.map((p) => p.path)).toContain("Notes/Trip.md");
		// By meaning alone, by words alone and for a note-level search.
		expect((await index.searchPassages(QUESTION, 20, 3, undefined, { lexical: false })).filter((p) => p.path.startsWith("Private/"))).toEqual([]);
		expect((await index.searchPassages("zanzibar quokka", 20)).filter((p) => p.path.startsWith("Private/"))).toEqual([]);
		expect((await index.searchNotes(QUESTION, 20)).filter((h) => h.path.startsWith("Private/"))).toEqual([]);
		expect((await index.search(QUESTION, 20)).filter((h) => h.path.startsWith("Private/"))).toEqual([]);
		// What the model is handed by the two search tools.
		for (const query of [QUESTION, "zanzibar", "quokka fund", "Diary", "letter never sent"]) {
			expect(leaks(await searchPassages.execute({ query, limit: 20 }, ctx)), `search_passages ${query}`).toBe(false);
			expect(leaks(await searchNotes.execute({ query, limit: 25 }, ctx)), `search_notes ${query}`).toBe(false);
		}
		// Related notes (the gardener, concept links) and the keyword scan's text come from the index too.
		expect(Array.from(index.noteVectors().keys()).filter((p) => p.startsWith("Private/"))).toEqual([]);
		for (const n of ["Private/Diary.md", "Private/Deep/Letter.md"]) expect(index.textFor(n, 1_700_000_003_000) ?? index.textFor(n, 1_700_000_004_000)).toBeUndefined();
	});

	it("says nothing about the vault's words that rests on an excluded note", async () => {
		const { index, exclude } = setup();
		await index.syncAll();
		await index.searchPassages(QUESTION, 4); // builds the word index
		expect(await index.absentWords("zanzibar")).toEqual([]); // a note in view has it
		exclude("Private");
		// Between the change and the sync nothing is claimed either way; after it the word is in no note the agent may see.
		expect(await index.absentWords("zanzibar")).toEqual([]);
		await index.syncAll();
		expect(await index.absentWords("zanzibar")).toEqual(["zanzibar"]);
		expect(await index.absentWords("ferry")).toEqual([]);
	});

	it("is searched with the excluded notes left out of the ranking, not only out of the result", async () => {
		const { index, exclude } = setup();
		await index.syncAll();
		exclude("Private");
		// Three excluded passages match "zanzibar ferry island" better than anything in view: the
		// notes in view must still fill the result, as they would after the next sync.
		const now = (await index.searchPassages("zanzibar ferry island", 2)).map((p) => p.path);
		await index.syncAll();
		const synced = (await index.searchPassages("zanzibar ferry island", 2)).map((p) => p.path);
		expect(now).toEqual(synced);
		expect(now).toHaveLength(2);
	});

	it("drops the excluded notes from the index and from what is saved at the next sync, and reads them again when the folder comes back", async () => {
		const { index, exclude, include, saved } = setup();
		await index.syncAll();
		exclude("Private");
		// Until the sync the entries are still there, unseen: typing a folder's name letter by letter throws nothing away.
		expect(index.status().indexedFiles).toBe(4);
		await index.syncAll();
		await index.flush();
		expect(index.status().indexedFiles).toBe(2);
		expect(Object.keys(saved()?.files ?? {}).filter((p) => p.startsWith("Private/"))).toEqual([]);
		include();
		expect((await index.searchPassages(QUESTION, 20)).filter((p) => p.path.startsWith("Private/"))).toEqual([]);
		await index.syncAll();
		expect((await index.searchPassages(QUESTION, 20)).some((p) => p.path === "Private/Diary.md")).toBe(true);
	});

	it("is not seen either when the setting was changed without telling the index", async () => {
		const { index, excluded } = setup();
		await index.syncAll();
		excluded.push("private/deep");
		const paths = (await index.searchPassages(QUESTION, 20)).map((p) => p.path);
		expect(paths).toContain("Private/Diary.md");
		expect(paths).not.toContain("Private/Deep/Letter.md");
	});
});
