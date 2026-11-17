import { describe, expect, it } from "vitest";
import { EXHAUSTIVE_PAIRS, gardenVault } from "../src/gardener";
import { SHARDS, SemanticIndex, shardOf, type IndexData, type IndexManifest, type IndexStore, type StoredFile } from "../src/index";
import { buildOutline } from "../src/outline";
import { keywordSearch } from "../src/search";
import { FakeOllama, FakeVault } from "./fakes";

class ShardStore implements IndexStore {
	manifest: IndexManifest | IndexData | null = null;
	shards = new Map<number, Record<string, StoredFile>>();
	writes: number[] = [];
	manifestWrites = 0;
	/** A shard whose file cannot be read (a write cut short by a crash). */
	failShard = -1;
	/** Holds the next shard write open until it resolves. */
	gate: Promise<void> | null = null;
	async load() {
		return this.manifest;
	}
	async save(d: IndexData) {
		this.manifest = d;
	}
	async loadShard(i: number) {
		if (i === this.failShard) throw new Error("Unexpected end of JSON input");
		return this.shards.get(i) ?? null;
	}
	async saveShard(i: number, files: Record<string, StoredFile>) {
		const gate = this.gate;
		this.gate = null;
		if (gate) await gate;
		this.shards.set(i, JSON.parse(JSON.stringify(files)) as Record<string, StoredFile>);
		this.writes.push(i);
	}
	async saveManifest(m: IndexManifest) {
		this.manifestWrites++;
		this.manifest = m;
	}
}

const opts = { getModel: () => "fake", isEnabled: () => true, shouldIndex: () => true };

function vaultOf(n: number): FakeVault {
	const v = new FakeVault();
	for (let i = 0; i < n; i++) v.seed(`Notes/Note ${i}.md`, `# Note ${i}\n\nText about topic${i % 7} and number ${i}.\n`);
	return v;
}

describe("sharded index storage", () => {
	it("spreads notes over shards deterministically", () => {
		expect(shardOf("A.md")).toBe(shardOf("A.md"));
		const used = new Set(Array.from({ length: 500 }, (_, i) => shardOf(`Notes/Note ${i}.md`)));
		expect(used.size).toBe(SHARDS);
		expect(Math.max(...used)).toBeLessThan(SHARDS);
	});

	it("writes every note once, then only the shard of an edited note", async () => {
		const vault = vaultOf(120);
		const store = new ShardStore();
		const index = new SemanticIndex(new FakeOllama([]).asClient(), vault, store, opts);
		await index.syncAll();
		expect(store.manifest).toMatchObject({ version: 2, model: "fake", shards: SHARDS });
		const stored = Array.from(store.shards.values()).reduce((n, s) => n + Object.keys(s).length, 0);
		expect(stored).toBe(120);

		store.writes = [];
		await vault.modify("Notes/Note 5.md", "# Note 5\n\nRewritten.\n");
		index.enqueue("Notes/Note 5.md");
		await new Promise((r) => setTimeout(r, 0));
		await index.flush();
		expect(store.writes).toEqual([shardOf("Notes/Note 5.md")]);
		expect(store.shards.get(shardOf("Notes/Note 5.md"))!["Notes/Note 5.md"].chunks[0].text).toContain("Rewritten");
	});

	it("loads from shards and searches without embedding anything again", async () => {
		const vault = vaultOf(40);
		const store = new ShardStore();
		await new SemanticIndex(new FakeOllama([]).asClient(), vault, store, opts).syncAll();
		const ollama = new FakeOllama([]);
		const index = new SemanticIndex(ollama.asClient(), vault, store, opts);
		await index.load();
		expect(index.status()).toMatchObject({ indexedFiles: 40, totalChunks: 40 });
		await index.syncAll();
		expect(ollama.embedCalls).toHaveLength(0);
		const hits = await index.search("number 17", 3);
		expect(hits).toHaveLength(3);
		expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
	});

	it("moves a one-file index from an earlier version into shards, keeping its vectors", async () => {
		const vault = vaultOf(10);
		const legacy: { data: IndexData | null } = { data: null };
		const old = new SemanticIndex(new FakeOllama([]).asClient(), vault, { load: async () => legacy.data, save: async (d) => void (legacy.data = d) }, opts);
		await old.syncAll();
		expect(legacy.data?.version).toBe(1);

		const store = new ShardStore();
		store.manifest = legacy.data;
		const ollama = new FakeOllama([]);
		const index = new SemanticIndex(ollama.asClient(), vault, store, opts);
		await index.load();
		await index.syncAll();
		await index.flush();
		expect(ollama.embedCalls).toHaveLength(0);
		expect(store.manifest).toMatchObject({ version: 2 });
		expect(Array.from(store.shards.values()).reduce((n, s) => n + Object.keys(s).length, 0)).toBe(10);
	});

	it("overwrites every shard of an index built with another model, so none of its vectors come back", async () => {
		const vault = vaultOf(120);
		const store = new ShardStore();
		await new SemanticIndex(new FakeOllama([]).asClient(), vault, store, opts).syncAll();

		// The next launch, with another embedding model in the settings.
		const other = { ...opts, getModel: () => "other" };
		const second = new SemanticIndex(new FakeOllama([]).asClient(), vault, store, other);
		await second.load();
		expect(second.status().indexedFiles).toBe(0);
		// Nothing embedded yet (a mistyped model name, say): the old index is left as it was.
		await second.flush();
		expect(store.manifest).toMatchObject({ model: "fake" });
		expect(Array.from(store.shards.values()).reduce((n, s) => n + Object.keys(s).length, 0)).toBe(120);

		// The rebuild stops after one note.
		second.enqueue("Notes/Note 5.md");
		await new Promise((r) => setTimeout(r, 0));
		await second.flush();
		expect(store.manifest).toMatchObject({ model: "other" });

		const third = new SemanticIndex(new FakeOllama([]).asClient(), vault, store, other);
		await third.load();
		expect(third.status().indexedFiles).toBe(1);
	});

	it("loses only the notes of an unreadable shard, and leaves an unchanged manifest alone", async () => {
		const vault = vaultOf(120);
		const store = new ShardStore();
		await new SemanticIndex(new FakeOllama([]).asClient(), vault, store, opts).syncAll();
		const bad = shardOf("Notes/Note 5.md");
		const inBad = Object.keys(store.shards.get(bad)!).length;
		expect(bad).toBeLessThan(SHARDS - 1); // shards after the bad one must still be read

		store.failShard = bad;
		store.writes = [];
		store.manifestWrites = 0;
		const ollama = new FakeOllama([]);
		const index = new SemanticIndex(ollama.asClient(), vault, store, opts);
		await index.load();
		expect(index.status().indexedFiles).toBe(120 - inBad);
		expect(index.status().lastError).toContain("unreadable");

		store.failShard = -1;
		await index.syncAll();
		expect(ollama.embedCalls.flat()).toHaveLength(inBad);
		expect(index.status()).toMatchObject({ indexedFiles: 120, lastError: undefined });
		expect(new Set(store.writes)).toEqual(new Set([bad]));
		expect(Object.keys(store.shards.get(bad)!)).toHaveLength(inBad);
		expect(store.manifestWrites).toBe(0);
	});

	it("does not let a slow save put an older copy of a shard over a newer one", async () => {
		const vault = vaultOf(120);
		const store = new ShardStore();
		const index = new SemanticIndex(new FakeOllama([]).asClient(), vault, store, opts);
		await index.syncAll();
		const a = "Notes/Note 5.md";
		const shard = shardOf(a);
		const b = Object.keys(store.shards.get(shard)!).find((p) => p !== a)!;
		expect(b).toBeDefined();

		let release!: () => void;
		store.gate = new Promise<void>((r) => (release = r));
		index.remove(a);
		const first = index.flush();
		await new Promise((r) => setTimeout(r, 0)); // the first save is now held open, with its copy of the shard taken
		index.remove(b);
		const second = index.flush();
		await new Promise((r) => setTimeout(r, 0));
		release();
		await Promise.all([first, second]);
		expect(Object.keys(store.shards.get(shard)!)).not.toContain(a);
		expect(Object.keys(store.shards.get(shard)!)).not.toContain(b);
	});

	it("keeps counts right through removals and renames, and serves note text to keyword search", async () => {
		const vault = vaultOf(5);
		const index = new SemanticIndex(new FakeOllama([]).asClient(), vault, new ShardStore(), opts);
		await index.syncAll();
		index.remove("Notes/Note 0.md");
		index.rename("Notes/Note 1.md", "Archive/Note 1.md");
		expect(index.status()).toMatchObject({ indexedFiles: 4, totalChunks: 4 });
		const note = vault.listNotes().find((n) => n.path === "Notes/Note 3.md")!;
		expect(index.textFor(note.path, note.mtime)).toContain("number 3");
		expect(index.textFor(note.path, note.mtime + 1)).toBeUndefined();
		const reads: string[] = [];
		const hits = await keywordSearch(vault, "number 3", 5, [note], (n) => (reads.push(n.path), index.textFor(n.path, n.mtime)));
		expect(hits[0].path).toBe("Notes/Note 3.md");
		expect(reads).toEqual(["Notes/Note 3.md"]);
	});
});

describe("whole-vault passes stay cheap", () => {
	it("reads each note's metadata once while fitting the outline, and none when names alone overflow", () => {
		const vault = vaultOf(30);
		let calls = 0;
		const real = vault.getMetadata.bind(vault);
		vault.getMetadata = (p: string) => {
			calls++;
			return real(p);
		};
		buildOutline(vault, 100000);
		expect(calls).toBe(30);
		calls = 0;
		const tight = buildOutline(vault, 200);
		expect(calls).toBe(0);
		expect(tight).toContain("Notes/ (30 notes");
	});

	it("finds mentions by a name's rarest word, and near-duplicates among many notes by shared lines", async () => {
		const vault = new FakeVault();
		const n = EXHAUSTIVE_PAIRS + 20;
		for (let i = 0; i < n; i++) vault.seed(`Lectures/Lecture ${i}.md`, `# Lecture ${i}\n\n${"filler sentence number " + i + " with enough words to count as a line. "}\n${"another distinct line for note " + i + " that is long enough."}\n${"third line, also unique to " + i + ", padding padding padding."}\n${"x".repeat(120)} ${i}\n`);
		vault.seed("Projects/Chess Robot.md", "# Chess Robot\n\nA robot arm that plays chess on a real board, long enough to matter here.\n");
		vault.seed("Daily/2026-01-05.md", "Worked on the Chess Robot gantry today, and read Lecture 7 again.\n");
		const dupText = "# Copy\n\nThe first shared line of this pair is long enough to count here.\nThe second shared line of this pair is also long enough.\nThe third shared line of the pair, likewise long enough.\nAnd a fourth shared line so that the overlap is clear.\n" + "y".repeat(100);
		vault.seed("Zettel/Original idea.md", dupText + "\nOnly in the original, one more line of text.\n");
		vault.seed("Zettel/Idea draft.md", dupText + "\n");
		const vectors = new Map(vault.listNotes().map((x) => [x.path, new Float32Array([1, 0])]));
		const report = await gardenVault(vault, { dailyFolder: "Daily", noteVectors: vectors });
		expect(report.mentions.map((m) => `${m.path}>${m.target}`)).toEqual(expect.arrayContaining(["Daily/2026-01-05.md>Projects/Chess Robot.md", "Daily/2026-01-05.md>Lectures/Lecture 7.md"]));
		expect(report.duplicates.some((d) => [d.a, d.b].sort().join("|") === "Zettel/Idea draft.md|Zettel/Original idea.md")).toBe(true);
	});
});
