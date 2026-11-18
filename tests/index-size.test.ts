import { describe, expect, it } from "vitest";
import { SemanticIndex, type IndexData } from "../src/index";
import { FakeOllama, FakeVault } from "./fakes";

/**
 * A note whose text changes while its modification time stays the same: a sync tool that restores
 * times, a backup put back. The index compares the time and the size the vault lists; it opens no
 * file to decide.
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

const NOTE = "Projects/Printer.md";
const T = 1_700_000_500_000;

function setup(store = new MemoryStore()) {
	const vault = new FakeVault({ "Recipes/Pasta.md": "Boil water, add pasta, stir." });
	vault.seed(NOTE, "The printer bed is levelled with three screws.", T);
	const reads: string[] = [];
	const read = vault.read.bind(vault);
	vault.read = async (path: string) => {
		reads.push(path);
		return read(path);
	};
	const ollama = new FakeOllama([]);
	const index = new SemanticIndex(ollama.asClient(), vault, store, { getModel: () => "nomic-embed-text", isEnabled: () => true, shouldIndex: () => true });
	return { vault, ollama, store, index, reads };
}

const size = (vault: FakeVault, path: string) => vault.listNotes().find((n) => n.path === path)!.size;
const mtime = (vault: FakeVault, path: string) => vault.listNotes().find((n) => n.path === path)!.mtime;

describe("a note changed while its modification time stays the same", () => {
	it("is read again at the next sync when its size differs", async () => {
		const { vault, index, reads } = setup();
		await index.syncAll();
		expect((await index.searchPassages("nozzle temperature", 3)).some((p) => p.text.includes("nozzle"))).toBe(false);
		// The sync tool writes a longer version and puts the old time back.
		vault.seed(NOTE, "The printer bed is levelled with three screws. The nozzle temperature for PETG is 240 degrees.", T);
		expect(mtime(vault, NOTE)).toBe(T);
		reads.length = 0;
		await index.syncAll();
		expect(reads).toEqual([NOTE]);
		const passages = await index.searchPassages("nozzle temperature", 3);
		expect(passages[0].path).toBe(NOTE);
		expect(passages[0].text).toContain("240 degrees");
		expect(index.unreadCount).toBe(0);
	});

	it("is not read from the index's memory by the keyword scan when its size differs", async () => {
		const { vault, index } = setup();
		await index.syncAll();
		expect(index.textFor(NOTE, T, size(vault, NOTE))).toContain("three screws");
		expect(index.textFor(NOTE, T)).toContain("three screws");
		vault.seed(NOTE, "The printer bed is levelled with four screws now.", T);
		expect(index.textFor(NOTE, T, size(vault, NOTE))).toBeUndefined();
	});

	it("nothing is read when neither the time nor the size changed", async () => {
		const { index, reads, ollama } = setup();
		await index.syncAll();
		reads.length = 0;
		ollama.embedCalls.length = 0;
		await index.syncAll();
		expect(reads).toEqual([]);
		expect(ollama.embedCalls).toEqual([]);
	});

	it("keeps the size across a save and a load", async () => {
		const first = setup();
		await first.index.syncAll();
		await first.index.flush();
		expect(first.store.data!.files[NOTE].size).toBe(size(first.vault, NOTE));
		const second = setup(first.store);
		await second.index.load();
		second.vault.seed(NOTE, "The printer bed is levelled with three screws. The nozzle temperature for PETG is 240 degrees.", T);
		await second.index.syncAll();
		// Only the changed note: the other one is the same by time and size.
		expect(second.reads).toEqual([NOTE]);
	});

	it("an entry saved without a size is not read again for that, takes the size the vault reports, and is compared by it from then on", async () => {
		const first = setup();
		await first.index.syncAll();
		await first.index.flush();
		for (const f of Object.values(first.store.data!.files)) delete f.size;
		const second = setup(first.store);
		await second.index.load();
		await second.index.syncAll();
		expect(second.reads).toEqual([]);
		expect(second.ollama.embedCalls).toEqual([]);
		await second.index.flush();
		expect(second.store.data!.files[NOTE].size).toBe(size(second.vault, NOTE));
		second.vault.seed(NOTE, "The printer bed is levelled with three screws. The nozzle temperature for PETG is 240 degrees.", T);
		await second.index.syncAll();
		expect(second.reads).toEqual([NOTE]);
	});

	// A limit, not a defect that can be fixed cheaply: telling these apart means reading every file.
	it("KNOWN GAP: a change that keeps both the time and the size is not seen until the index is rebuilt", async () => {
		const { vault, index, reads } = setup();
		await index.syncAll();
		const before = "The printer bed is levelled with three screws.";
		const after = "The printer bed is levelled with eleven bolts.";
		expect(after.length).toBe(before.length);
		vault.seed(NOTE, after, T);
		reads.length = 0;
		await index.syncAll();
		expect(reads).toEqual([]);
		expect((await index.searchPassages("eleven bolts", 3)).some((p) => p.text.includes("eleven bolts"))).toBe(false);
		// "Rebuild semantic index" reads everything.
		await index.syncAll(true);
		expect((await index.searchPassages("eleven bolts", 3))[0].text).toContain("eleven bolts");
	});
});
