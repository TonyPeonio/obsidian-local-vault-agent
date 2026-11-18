import { describe, expect, it } from "vitest";
import { SemanticIndex, type IndexData } from "../src/index";
import LocalVaultAgentPlugin from "../src/main";
import type { OllamaClient } from "../src/ollama";
import { FakeOllama, FakeVault } from "./fakes";

/**
 * Review of 24f190f and 7269840 (the index while a note is in the embedding request, and the size
 * comparison): no change of theirs may drop a note that still exists, index a note twice, or keep
 * the index busy without end. The events are delivered as the plugin delivers them: `touch` at
 * once for every edit, `enqueue` once after the typing pause, `remove` for a deletion.
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

const NOTE = "Projects/Gantry.md";
const FIRST = "The gantry carries an electromagnet over the chessboard.";

function setup() {
	const vault = new FakeVault({
		[NOTE]: FIRST,
		"Recipes/Pasta.md": "Boil water, add pasta, stir.",
		"Recipes/Bread.md": "Flour, water, salt and yeast; knead and wait.",
	});
	const reads: string[] = [];
	const read = vault.read.bind(vault);
	vault.read = async (path: string) => {
		reads.push(path);
		return read(path);
	};
	const fake = new FakeOllama([]);
	const store = new MemoryStore();
	let pending: { arrived: () => void; opened: Promise<void> } | null = null;
	/** Makes the next embedding request wait: `entered` resolves when it has arrived, `open` lets it go on. */
	const hold = (): { open: () => void; entered: Promise<void> } => {
		let arrived!: () => void;
		const entered = new Promise<void>((r) => (arrived = r));
		let open!: () => void;
		const opened = new Promise<void>((r) => (open = r));
		pending = { arrived, opened };
		return { open, entered };
	};
	const state = { down: false };
	const client = {
		embed: async (model: string, inputs: string[]) => {
			if (state.down) throw new Error("Cannot reach the embedding server");
			const p = pending;
			if (p) {
				pending = null;
				p.arrived();
				await p.opened;
			}
			return fake.embed(model, inputs);
		},
	} as unknown as OllamaClient;
	const index = new SemanticIndex(client, vault, store, { getModel: () => "nomic-embed-text", isEnabled: () => true, shouldIndex: () => true });
	return { vault, store, index, hold, reads, fake, state };
}

/** What the index holds of the note, as a search and the saved file show it. */
async function held(index: SemanticIndex, store: MemoryStore): Promise<{ saved: string; entries: number }> {
	await index.flush();
	const files = store.data?.files ?? {};
	return { saved: (files[NOTE]?.chunks ?? []).map((c) => c.text).join("\n"), entries: Object.keys(files).filter((p) => p === NOTE).length };
}

/** The index is at rest: nothing queued, nothing being embedded, nothing known to be out of date. */
function atRest(index: SemanticIndex): void {
	expect(index.status().pending).toBe(0);
	expect(index.status().building).toBe(false);
	expect(index.unreadCount).toBe(0);
	expect(index.status().lastError).toBeUndefined();
}

describe("a note edited ten times while it is being embedded", () => {
	it("the pause ends after the embedding: the last text is indexed, the note is read once more, and the index comes to rest", async () => {
		const { vault, store, index, hold, reads } = setup();
		await index.syncAll();
		await vault.modify(NOTE, `${FIRST} Edit 0.`);
		index.touch(NOTE);
		const gate = hold();
		index.enqueue(NOTE);
		await gate.entered;
		reads.length = 0;
		for (let i = 1; i <= 10; i++) {
			await vault.modify(NOTE, `${FIRST} Edit ${i} mentions a zeppelin.`);
			index.touch(NOTE);
		}
		gate.open();
		await index.idle();
		// Between the embedding and the end of the typing pause the index holds an older text and knows it.
		expect(index.unreadCount).toBe(1);
		expect(index.status().indexedFiles).toBe(3);
		// The typing pause ends: one `enqueue`.
		index.enqueue(NOTE);
		await index.idle();
		expect(reads).toEqual([NOTE]);
		const h = await held(index, store);
		expect(h.entries).toBe(1);
		expect(h.saved).toContain("Edit 10 mentions a zeppelin.");
		expect(index.status().indexedFiles).toBe(3);
		atRest(index);
	});

	it("the pause ends ten times during the embedding: the note is read once more, not ten times", async () => {
		const { vault, store, index, hold, reads } = setup();
		await index.syncAll();
		await vault.modify(NOTE, `${FIRST} Edit 0.`);
		index.touch(NOTE);
		const gate = hold();
		index.enqueue(NOTE);
		await gate.entered;
		reads.length = 0;
		for (let i = 1; i <= 10; i++) {
			await vault.modify(NOTE, `${FIRST} Edit ${i} mentions a zeppelin.`);
			index.touch(NOTE);
			index.enqueue(NOTE);
		}
		gate.open();
		await index.idle();
		expect(reads).toEqual([NOTE]);
		const h = await held(index, store);
		expect(h.entries).toBe(1);
		expect(h.saved).toContain("Edit 10 mentions a zeppelin.");
		expect(h.saved).not.toContain("Edit 0.");
		expect(index.status().indexedFiles).toBe(3);
		expect((await index.searchPassages("zeppelin", 5)).filter((p) => p.path === NOTE)).toHaveLength(1);
		atRest(index);
	});

	it("a sync in the middle of it queues the note once and does not start a second pass", async () => {
		const { vault, store, index, hold, reads } = setup();
		await index.syncAll();
		await vault.modify(NOTE, `${FIRST} Edit 0.`);
		index.touch(NOTE);
		const gate = hold();
		index.enqueue(NOTE);
		await gate.entered;
		reads.length = 0;
		await vault.modify(NOTE, `${FIRST} Edit 1 mentions a zeppelin.`);
		index.touch(NOTE);
		const sync = index.syncAll();
		gate.open();
		await sync;
		await index.idle();
		expect(reads).toEqual([NOTE]);
		expect((await held(index, store)).saved).toContain("Edit 1 mentions a zeppelin.");
		// Nothing differs any more: another sync reads nothing.
		reads.length = 0;
		await index.syncAll();
		expect(reads).toEqual([]);
		atRest(index);
	});
});

describe("a note deleted and created again at the same path", () => {
	const SECOND = "A new note about the zeppelin hangar, nothing else.";

	it("while the old one is being embedded: the old text is not kept, the new one is indexed, once", async () => {
		const { vault, store, index, hold } = setup();
		await index.syncAll();
		await vault.modify(NOTE, `${FIRST} It homes on two limit switches.`);
		index.touch(NOTE);
		const gate = hold();
		index.enqueue(NOTE);
		await gate.entered;
		await vault.trash(NOTE);
		index.remove(NOTE);
		await vault.create(NOTE, SECOND);
		index.touch(NOTE);
		gate.open();
		await index.idle();
		// Until the pause after the creation ends, the path is not in the index, and the index knows a note is unread.
		expect((await held(index, store)).entries).toBe(0);
		expect(index.unreadCount).toBe(1);
		index.enqueue(NOTE);
		await index.idle();
		const h = await held(index, store);
		expect(h.entries).toBe(1);
		expect(h.saved).toBe(SECOND);
		expect(index.status().indexedFiles).toBe(3);
		expect((await index.searchPassages("electromagnet limit switches", 5)).some((p) => p.text.includes("electromagnet"))).toBe(false);
		atRest(index);
	});

	it("with the pause after the creation ending while the old one is still being embedded", async () => {
		const { vault, store, index, hold, reads } = setup();
		await index.syncAll();
		await vault.modify(NOTE, `${FIRST} It homes on two limit switches.`);
		index.touch(NOTE);
		const gate = hold();
		index.enqueue(NOTE);
		await gate.entered;
		reads.length = 0;
		await vault.trash(NOTE);
		index.remove(NOTE);
		await vault.create(NOTE, SECOND);
		index.touch(NOTE);
		index.enqueue(NOTE);
		gate.open();
		await index.idle();
		expect(reads).toEqual([NOTE]);
		const h = await held(index, store);
		expect(h.entries).toBe(1);
		expect(h.saved).toBe(SECOND);
		expect(index.status().indexedFiles).toBe(3);
		atRest(index);
	});

	it("while nothing is being embedded, and again by the next sync when no event told of it", async () => {
		const { vault, store, index } = setup();
		await index.syncAll();
		await vault.trash(NOTE);
		index.remove(NOTE);
		await vault.create(NOTE, SECOND);
		index.touch(NOTE);
		index.enqueue(NOTE);
		await index.idle();
		expect((await held(index, store)).saved).toBe(SECOND);
		// Replaced behind the plugin's back (Obsidian closed): the sync sees another time or size.
		await vault.trash(NOTE);
		await vault.create(NOTE, FIRST);
		await index.syncAll();
		const h = await held(index, store);
		expect(h.entries).toBe(1);
		expect(h.saved).toBe(FIRST);
		expect(index.status().indexedFiles).toBe(3);
		atRest(index);
	});

	it("the embedding server failing on the new note leaves it queued for the next sync, not lost and not retried in a loop", async () => {
		const { vault, store, index, hold, reads, state } = setup();
		await index.syncAll();
		await vault.modify(NOTE, `${FIRST} It homes on two limit switches.`);
		index.touch(NOTE);
		const gate = hold();
		index.enqueue(NOTE);
		await gate.entered;
		await vault.trash(NOTE);
		index.remove(NOTE);
		await vault.create(NOTE, SECOND);
		index.touch(NOTE);
		index.enqueue(NOTE);
		state.down = true;
		reads.length = 0;
		gate.open();
		await index.idle();
		// One attempt, an error to show, and the note still known to be unread.
		expect(reads).toEqual([NOTE]);
		expect(index.status().lastError).toContain("Cannot reach");
		expect(index.unreadCount).toBe(1);
		expect((await held(index, store)).entries).toBe(0);
		state.down = false;
		await index.syncAll();
		expect((await held(index, store)).saved).toBe(SECOND);
		atRest(index);
	});
});

describe("the keyword scan of a large vault asks the index with the note's size (src/main.ts)", () => {
	it("a note whose size changed under the same modification time is read from the vault, not from the index's memory", async () => {
		const T = 1_700_000_900_000;
		const vault = new FakeVault();
		for (let i = 0; i < 2001; i++) vault.seed(`Bulk/Note ${i}.md`, `Filler line number ${i}.`);
		vault.seed(NOTE, "The printer bed is levelled with three screws.", T);
		const state = { down: false };
		const fake = new FakeOllama([]);
		const client = {
			embed: async (model: string, inputs: string[]) => {
				if (state.down) throw new Error("Cannot reach the embedding server");
				return fake.embed(model, inputs);
			},
		} as unknown as OllamaClient;
		const index = new SemanticIndex(client, vault, new MemoryStore(), { getModel: () => "nomic-embed-text", isEnabled: () => true, shouldIndex: () => true });
		await index.syncAll();
		expect(index.status().indexedFiles).toBe(2002);
		// A sync tool writes a longer text and restores the time; the index has not been synced since.
		vault.seed(NOTE, "The printer bed is levelled with three screws. The nozzle temperature for PETG is 240 degrees.", T);
		// The embedding server does not answer, so the search falls back to the keyword scan.
		state.down = true;
		const p = Object.assign(Object.create(LocalVaultAgentPlugin.prototype) as LocalVaultAgentPlugin, { index, vault, app: { metadataCache: { getCache: () => null } } });
		const hits = await p.hybridSearch("nozzle temperature PETG", 5);
		expect(hits.map((h) => h.path)).toContain(NOTE);
		// An unchanged note is still answered from memory: the scan does not read 2,000 files.
		const reads: string[] = [];
		const read = vault.read.bind(vault);
		vault.read = async (path: string) => {
			reads.push(path);
			return read(path);
		};
		await p.hybridSearch("Filler line number 1234", 5);
		expect(reads).toEqual([NOTE]);
	});
});
