import { describe, expect, it } from "vitest";
import { SemanticIndex, cosine, embedInput, type IndexData } from "../src/index";
import { FakeOllama, FakeVault } from "./fakes";

class MemoryStore {
	data: IndexData | null = null;
	saves = 0;
	async load() {
		return this.data;
	}
	async save(d: IndexData) {
		this.data = JSON.parse(JSON.stringify(d));
		this.saves++;
	}
}

function setup(enabled = true, excluded: string[] = []) {
	const vault = new FakeVault({
		"Projects/Chess Robot.md": "# Chess Robot\n\nThe gantry moves pieces with an electromagnet.\n\n## Sensors\n\nHall sensors detect pieces.",
		"Recipes/Pasta.md": "Boil water, add pasta, stir.",
		"Templates/Daily.md": "template",
	});
	const ollama = new FakeOllama([]);
	const store = new MemoryStore();
	const index = new SemanticIndex(ollama.asClient(), vault, store, {
		getModel: () => "nomic-embed-text",
		isEnabled: () => enabled,
		shouldIndex: (p) => !excluded.some((e) => p.startsWith(e + "/")),
		batchSize: 2,
	});
	return { vault, ollama, store, index };
}

describe("helpers", () => {
	it("cosine is 1 for identical and 0 for orthogonal vectors", () => {
		expect(cosine(new Float32Array([1, 2]), new Float32Array([1, 2]))).toBeCloseTo(1);
		expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
	});
	it("adds nomic task prefixes only for nomic models", () => {
		expect(embedInput("nomic-embed-text", "x", "query")).toBe("search_query: x");
		expect(embedInput("nomic-embed-text:v1.5", "x", "document")).toBe("search_document: x");
		expect(embedInput("mxbai-embed-large", "x", "query")).toBe("x");
	});
});

describe("SemanticIndex", () => {
	it("indexes every included note, chunked, and persists", async () => {
		const { index, store, ollama } = setup(true, ["Templates"]);
		await index.syncAll();
		const s = index.status();
		expect(s.indexedFiles).toBe(2);
		expect(s.totalChunks).toBe(3); // "Chess Robot" + "Sensors" + pasta
		expect(s.building).toBe(false);
		expect(store.saves).toBeGreaterThan(0);
		expect(Object.keys(store.data!.files)).not.toContain("Templates/Daily.md");
		// Documents were sent with the nomic prefix and in batches of 2.
		expect(ollama.embedCalls.flat().every((i) => i.startsWith("search_document: "))).toBe(true);
		expect(ollama.embedCalls.every((b) => b.length <= 2)).toBe(true);
	});

	it("searches by similarity and returns the best chunk per note", async () => {
		const { index } = setup();
		await index.syncAll();
		const hits = await index.search("hall sensors pieces", 5);
		expect(hits[0].path).toBe("Projects/Chess Robot.md");
		expect(hits[0].heading).toBe("Sensors");
		expect(hits.map((h) => h.path)).toHaveLength(new Set(hits.map((h) => h.path)).size);
	});

	it("re-embeds only changed notes on the next sync", async () => {
		const { index, vault, ollama } = setup();
		await index.syncAll();
		const before = ollama.embedCalls.length;
		await vault.modify("Recipes/Pasta.md", "Boil water, add rice.");
		await index.syncAll();
		const inputs = ollama.embedCalls.slice(before).flat();
		expect(inputs).toHaveLength(1);
		expect(inputs[0]).toContain("rice");
	});

	it("handles delete and rename", async () => {
		const { index, store } = setup();
		await index.syncAll();
		index.rename("Recipes/Pasta.md", "Food/Pasta.md");
		expect(index.status().indexedFiles).toBe(3);
		index.remove("Food/Pasta.md");
		expect(index.status().indexedFiles).toBe(2);
		await index.flush();
		expect(Object.keys(store.data!.files)).toEqual(expect.not.arrayContaining(["Recipes/Pasta.md", "Food/Pasta.md"]));
	});

	it("reloads a saved index and ignores one built with another model", async () => {
		const { index, store, ollama } = setup();
		await index.syncAll();
		const fresh = new SemanticIndex(ollama.asClient(), new FakeVault(), store, {
			getModel: () => "nomic-embed-text",
			isEnabled: () => true,
			shouldIndex: () => true,
		});
		await fresh.load();
		expect(fresh.status().indexedFiles).toBe(3);
		const other = new SemanticIndex(ollama.asClient(), new FakeVault(), store, {
			getModel: () => "different-model",
			isEnabled: () => true,
			shouldIndex: () => true,
		});
		await other.load();
		expect(other.status().indexedFiles).toBe(0);
	});

	it("does nothing when disabled", async () => {
		const { index, ollama } = setup(false);
		await index.syncAll();
		expect(ollama.embedCalls).toHaveLength(0);
		expect(await index.search("x", 3)).toEqual([]);
	});

	it("records an error and keeps going on the next sync", async () => {
		const { index, ollama } = setup();
		const fail = ollama as unknown as { embed: FakeOllama["embed"] };
		const original = fail.embed.bind(ollama);
		fail.embed = async () => {
			throw new Error("boom");
		};
		await index.syncAll();
		expect(index.status().lastError).toBe("boom");
		fail.embed = original;
		await index.syncAll();
		expect(index.status().lastError).toBeUndefined();
		expect(index.status().indexedFiles).toBe(3);
	});
});

describe("searchPassages", () => {
	it("returns chunk-level hits with text, capped per note", async () => {
		const { index } = setup();
		await index.syncAll();
		const all = await index.searchPassages("hall sensors detect pieces", 10);
		expect(all.length).toBe(4); // two chunks of Chess Robot + Pasta + Templates/Daily
		expect(all[0]).toMatchObject({ path: "Projects/Chess Robot.md", heading: "Sensors" });
		expect(all[0].text).toContain("Hall sensors detect pieces");
		const capped = await index.searchPassages("hall sensors detect pieces", 10, 1);
		expect(capped.filter((p) => p.path === "Projects/Chess Robot.md")).toHaveLength(1);
		expect(await index.searchPassages("x", 2)).toHaveLength(2);
	});

	it("embeds only the chunks that changed when a note is edited", async () => {
		const { index, ollama, vault, store } = setup(true, ["Templates"]);
		await index.syncAll();
		const before = JSON.parse(JSON.stringify(store.data!.files["Projects/Chess Robot.md"].chunks)) as { heading: string; text: string; vec: string }[];
		ollama.embedCalls.length = 0;

		// A new section at the end, as a transcript or a daily note grows: one new chunk, one embedding.
		await vault.modify("Projects/Chess Robot.md", "# Chess Robot\n\nThe gantry moves pieces with an electromagnet.\n\n## Sensors\n\nHall sensors detect pieces.\n\n## Firmware\n\nThe controller runs GRBL.");
		await index.syncAll();
		expect(ollama.embedCalls.flat()).toHaveLength(1);
		expect(ollama.embedCalls.flat()[0]).toContain("The controller runs GRBL.");
		const after = store.data!.files["Projects/Chess Robot.md"].chunks;
		expect(after).toHaveLength(before.length + 1);
		// The untouched chunks kept their vectors, and the note is fully searchable.
		for (const c of before) expect(after.find((a) => a.heading === c.heading && a.text === c.text)?.vec).toBe(c.vec);
		expect((await index.searchPassages("controller GRBL firmware", 1))[0].text).toContain("GRBL");

		// Saved again with the same text (only the mtime moved): nothing is sent at all.
		ollama.embedCalls.length = 0;
		await vault.modify("Projects/Chess Robot.md", await vault.read("Projects/Chess Robot.md"));
		await index.syncAll();
		expect(ollama.embedCalls).toHaveLength(0);

		// A forced rebuild still embeds everything.
		await index.syncAll(true);
		expect(ollama.embedCalls.flat().length).toBeGreaterThan(after.length);
	});
});
