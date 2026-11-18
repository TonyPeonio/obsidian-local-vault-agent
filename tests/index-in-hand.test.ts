import { describe, expect, it } from "vitest";
import { SemanticIndex, type IndexData } from "../src/index";
import type { OllamaClient } from "../src/ollama";
import { FakeOllama, FakeVault } from "./fakes";

/**
 * A note that is deleted, renamed or moved to an excluded folder while the index is embedding it.
 * The embedding request is held open here, the vault event is delivered as the plugin delivers it
 * (`remove`, `rename`), and then the request is let go: nothing of the old path may be left.
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

const GANTRY = "Projects/Gantry.md";
const GANTRY_TEXT = "The gantry carries an electromagnet over the chessboard.";

function setup(excluded: string[] = []) {
	const vault = new FakeVault({
		[GANTRY]: GANTRY_TEXT,
		"Recipes/Pasta.md": "Boil water, add pasta, stir.",
		"Recipes/Bread.md": "Flour, water, salt and yeast; knead and wait.",
	});
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
	const client = {
		embed: async (model: string, inputs: string[]) => {
			const p = pending;
			if (p) {
				pending = null;
				p.arrived();
				await p.opened;
			}
			return fake.embed(model, inputs);
		},
	} as unknown as OllamaClient;
	const index = new SemanticIndex(client, vault, store, {
		getModel: () => "nomic-embed-text",
		isEnabled: () => true,
		shouldIndex: (p) => !excluded.some((e) => p.startsWith(e + "/")),
	});
	return { vault, store, index, hold };
}

/** Every path a search of any kind can return, and every path that is saved. */
async function pathsSeen(index: SemanticIndex, store: MemoryStore, query: string): Promise<string[]> {
	await index.flush();
	const found = [...(await index.search(query, 10)).map((h) => h.path), ...(await index.searchPassages(query, 10)).map((p) => p.path), ...(await index.searchNotes(query, 10)).map((h) => h.path)];
	return Array.from(new Set([...found, ...Object.keys(store.data?.files ?? {})])).sort();
}

describe("a note that goes away while it is being embedded", () => {
	it("deleted during its first embedding: it is not in the index afterwards", async () => {
		const { vault, store, index, hold } = setup();
		const gate = hold();
		const sync = index.syncAll();
		await gate.entered;
		// The first note of the pass is in the embedding request now. The user deletes it.
		await vault.trash(GANTRY);
		index.remove(GANTRY);
		gate.open();
		await sync;
		await index.idle();
		expect(index.status().indexedFiles).toBe(2);
		expect(await pathsSeen(index, store, "gantry electromagnet chessboard")).toEqual(["Recipes/Bread.md", "Recipes/Pasta.md"]);
	});

	it("deleted while an edit of it is being embedded: the old entry does not come back", async () => {
		const { vault, store, index, hold } = setup();
		await index.syncAll();
		await vault.modify(GANTRY, GANTRY_TEXT + " It homes on two limit switches.");
		index.touch(GANTRY);
		const gate = hold();
		index.enqueue(GANTRY);
		await gate.entered;
		await vault.trash(GANTRY);
		index.remove(GANTRY);
		gate.open();
		await index.idle();
		expect(await pathsSeen(index, store, "gantry limit switches")).toEqual(["Recipes/Bread.md", "Recipes/Pasta.md"]);
		expect(index.unreadCount).toBe(0);
	});

	it("renamed while it is being embedded: indexed under the new name only, with its current text", async () => {
		const { vault, store, index, hold } = setup();
		await index.syncAll();
		await vault.modify(GANTRY, GANTRY_TEXT + " It homes on two limit switches.");
		index.touch(GANTRY);
		const gate = hold();
		index.enqueue(GANTRY);
		await gate.entered;
		await vault.rename(GANTRY, "Projects/Chess gantry.md");
		index.rename(GANTRY, "Projects/Chess gantry.md");
		gate.open();
		await index.idle();
		expect(await pathsSeen(index, store, "gantry limit switches")).toEqual(["Projects/Chess gantry.md", "Recipes/Bread.md", "Recipes/Pasta.md"]);
		const passages = await index.searchPassages("limit switches", 3);
		expect(passages[0].path).toBe("Projects/Chess gantry.md");
		expect(passages[0].text).toContain("limit switches");
		expect(index.unreadCount).toBe(0);
	});

	it("moved into an excluded folder while it is being embedded: neither path is in the index", async () => {
		const { vault, store, index, hold } = setup(["Private"]);
		await index.syncAll();
		await vault.modify(GANTRY, GANTRY_TEXT + " It homes on two limit switches.");
		index.touch(GANTRY);
		const gate = hold();
		index.enqueue(GANTRY);
		await gate.entered;
		await vault.rename(GANTRY, "Private/Gantry.md");
		index.rename(GANTRY, "Private/Gantry.md");
		gate.open();
		await index.idle();
		expect(await pathsSeen(index, store, "gantry limit switches")).toEqual(["Recipes/Bread.md", "Recipes/Pasta.md"]);
	});

	it("renamed away and another note renamed onto its name: the name keeps the other note's text", async () => {
		const { vault, store, index, hold } = setup();
		await index.syncAll();
		await vault.modify(GANTRY, GANTRY_TEXT + " It homes on two limit switches.");
		index.touch(GANTRY);
		const gate = hold();
		index.enqueue(GANTRY);
		await gate.entered;
		await vault.rename(GANTRY, "Projects/Old gantry.md");
		index.rename(GANTRY, "Projects/Old gantry.md");
		await vault.rename("Recipes/Bread.md", GANTRY);
		index.rename("Recipes/Bread.md", GANTRY);
		gate.open();
		await index.idle();
		expect(await pathsSeen(index, store, "flour yeast")).toEqual(["Projects/Gantry.md", "Projects/Old gantry.md", "Recipes/Pasta.md"]);
		const stored = store.data!.files[GANTRY].chunks.map((c) => c.text).join("\n");
		expect(stored).toContain("yeast");
		expect(stored).not.toContain("electromagnet");
	});

	it("a note still there is indexed as before, and the rest of the queue is done", async () => {
		const { store, index, hold } = setup();
		const gate = hold();
		const sync = index.syncAll();
		await gate.entered;
		gate.open();
		await sync;
		expect(await pathsSeen(index, store, "gantry")).toEqual([GANTRY, "Recipes/Bread.md", "Recipes/Pasta.md"]);
	});
});

describe("a note deleted between the index's look and its read", () => {
	it("is forgotten, and the notes queued after it are still indexed", async () => {
		const { vault, store, index } = setup();
		const read = vault.read.bind(vault);
		vault.read = async (path: string) => {
			// The file goes at the worst moment: after `exists` said yes.
			if (path === GANTRY && vault.exists(GANTRY)) await vault.trash(GANTRY);
			return read(path);
		};
		await index.syncAll();
		expect(index.status().lastError).toBeUndefined();
		expect(await pathsSeen(index, store, "gantry")).toEqual(["Recipes/Bread.md", "Recipes/Pasta.md"]);
	});
});
