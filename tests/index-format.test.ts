import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/chunker";
import { EMBED_FORMAT, SemanticIndex, type IndexData } from "../src/index";
import { FakeOllama, FakeVault } from "./fakes";

/**
 * Which stored notes are cut into passages again, and when. The cutting changed in 0.9.0 (a table
 * longer than one chunk is cut between rows, each piece under the heading row) without a new
 * `EMBED_FORMAT`. These tests say what that leaves as it was, and that it is never an index
 * written by the released 0.8.0, whose entries carry no format number at all.
 */

class MemoryStore {
	data: IndexData | null = null;
	async load() {
		return this.data;
	}
	async save(d: IndexData) {
		this.data = JSON.parse(JSON.stringify(d));
	}
}

const HEAD = "| Part | Frame | Holding torque |\n| --- | --- | --- |";
const rows = Array.from({ length: 90 }, (_, i) => `| M-${100 + i} | NEMA ${17 + (i % 3)} | ${10 + i} N·cm with the long shaft option |`);
const TABLE_NOTE = `# Motors\n\n${HEAD}\n${rows.join("\n")}\n`;
const NOTES = { "Parts/Motors.md": TABLE_NOTE, "Recipes/Pasta.md": "Boil water, add pasta, stir." };

/** One sync by a fresh index, then the saved file altered as an older build would have written it. */
async function savedBy(alter: (entry: IndexData["files"][string]) => void) {
	const vault = new FakeVault({ ...NOTES });
	const store = new MemoryStore();
	const opts = { getModel: () => "nomic-embed-text", isEnabled: () => true, shouldIndex: () => true, batchSize: 16 };
	const first = new SemanticIndex(new FakeOllama([]).asClient(), vault, store, opts);
	await first.syncAll();
	await first.flush();
	for (const entry of Object.values(store.data!.files)) {
		// The pieces an older cutting left: every chunk's text marked, so none equals a piece cut today.
		entry.chunks = entry.chunks.map((c) => ({ ...c, text: `OLD CUT ${c.text}` }));
		alter(entry);
	}
	const ollama = new FakeOllama([]);
	const index = new SemanticIndex(ollama.asClient(), vault, store, opts);
	await index.load();
	const texts = async (path: string) => {
		await index.flush();
		return store.data!.files[path].chunks.map((c) => c.text);
	};
	return { index, ollama, texts };
}

const cutToday = (path: keyof typeof NOTES) => chunkMarkdown(NOTES[path]).map((c) => c.text);

describe("which notes an index from an earlier build cuts again", () => {
	it("cuts the long table of these tests into several pieces, each under the heading row", () => {
		const pieces = cutToday("Parts/Motors.md");
		expect(pieces.length).toBeGreaterThan(1);
		for (const p of pieces) expect(p.startsWith(HEAD), p.slice(0, 60)).toBe(true);
	});

	it("an index saved by the released 0.8.0 (no format number on its entries): every note, on the first sync", async () => {
		const { index, ollama, texts } = await savedBy((entry) => {
			delete entry.fmt;
			delete entry.rest;
		});
		await index.syncAll();
		expect(await texts("Parts/Motors.md")).toEqual(cutToday("Parts/Motors.md"));
		expect(await texts("Recipes/Pasta.md")).toEqual(cutToday("Recipes/Pasta.md"));
		// Only pieces whose text is new are embedded: here all of them, since every old piece differs.
		expect(ollama.embedCalls.flat()).toHaveLength(cutToday("Parts/Motors.md").length + cutToday("Recipes/Pasta.md").length);
	});

	it("an index saved by a development build of 0.9.0 with the format number of today: no note, until it changes", async () => {
		const { index, ollama, texts } = await savedBy((entry) => {
			expect(entry.fmt).toBe(EMBED_FORMAT);
			expect(entry.rest).toBeDefined();
		});
		await index.syncAll();
		expect((await texts("Parts/Motors.md")).every((t) => t.startsWith("OLD CUT "))).toBe(true);
		expect(ollama.embedCalls).toHaveLength(0);
	});

	it("Rebuild index (syncAll(true)): every note, whatever the saved entries say", async () => {
		const { index, ollama, texts } = await savedBy(() => undefined);
		await index.syncAll(true);
		expect(await texts("Parts/Motors.md")).toEqual(cutToday("Parts/Motors.md"));
		expect(await texts("Recipes/Pasta.md")).toEqual(cutToday("Recipes/Pasta.md"));
		// From scratch: nothing kept, every piece embedded.
		expect(ollama.embedCalls.flat()).toHaveLength(cutToday("Parts/Motors.md").length + cutToday("Recipes/Pasta.md").length);
	});
});
