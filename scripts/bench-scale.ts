import "../tests/setup";
/**
 * Large-vault benchmark: how long the plugin's own work takes at 10,000 and 50,000 notes, apart
 * from the embedding model. Notes are generated in memory (deterministic), embeddings come from a
 * hash-based stand-in with the real model's dimensions (768), so the numbers are the index's
 * bookkeeping, storage and search, which is what grows with the vault; the embedding model's own
 * speed is measured separately with EMBED=real on a sample and scales linearly.
 *
 *   npm run bench:scale                  # 10k and 50k notes
 *   NOTES=10000 npm run bench:scale      # one size
 *   EMBED=real SAMPLE=300 npm run bench:scale   # also time the real embedding model on 300 notes
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { buildSystemPrompt, type AgentConfig } from "../src/agent";
import { gardenVault } from "../src/gardener";
import { SemanticIndex, type IndexData, type IndexManifest, type IndexStore, type StoredFile } from "../src/index";
import { OllamaClient } from "../src/ollama";
import { keywordSearch } from "../src/search";
import { grepVault } from "../src/tools";
import { FakeVault } from "../tests/fakes";

const SIZES = (process.env.NOTES ?? "10000,50000").split(",").map(Number);
const DIMS = 768;
const WORDS = "gradient entropy membrane voltage torque compiler lattice enzyme treaty sonata harvest ledger orbit glacier syntax protein inflation canvas reactor dialect theorem pigment estuary quorum relay spindle archive beacon cascade delta ember fjord garnet harbor isotope jasmine kernel lantern meadow nebula oxide prism quartz ripple summit tundra umber vortex willow xenon yarrow zephyr".split(" ");

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

function makeVault(n: number): FakeVault {
	const r = rng(42);
	const vault = new FakeVault();
	const word = () => WORDS[Math.floor(r() * WORDS.length)];
	const sentence = () => Array.from({ length: 8 + Math.floor(r() * 10) }, word).join(" ") + ".";
	const folders = ["Zettel", "Library", "Projects", "Courses/A", "Courses/B", "Archive/2024", "Archive/2025", "People", "Daily"];
	for (let i = 0; i < n; i++) {
		const folder = folders[i % folders.length];
		const name = folder === "Daily" ? `${2000 + Math.floor(i / 3000)}-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (Math.floor(i / 12) % 28)).padStart(2, "0")}-${i}` : `${word()} ${word()} ${i}`;
		const body = [`# ${name}`, "", sentence(), sentence(), "", "## Notes", "", sentence(), sentence(), sentence(), "", "## Open questions", "", `- ${sentence()}`, `- ${sentence()}`, ""].join("\n");
		vault.seed(`${folder}/${name}.md`, body, 1_700_000_000_000 + i * 1000);
	}
	return vault;
}

/** A stand-in embedding model: deterministic 768-number vectors from the words of the text. */
class FakeEmbedder {
	async embed(_model: string, inputs: string[]): Promise<number[][]> {
		return inputs.map((text) => {
			const v = new Array<number>(DIMS).fill(0);
			for (const w of text.toLowerCase().split(/\W+/)) {
				if (!w) continue;
				let h = 2166136261;
				for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0;
				v[h % DIMS] += 1;
				v[(h >>> 8) % DIMS] += 0.5;
			}
			return v;
		});
	}
}

/** An in-memory store that keeps the serialised JSON, as the plugin writes it to disk. */
class MemStore implements IndexStore {
	manifest: string | null = null;
	shards = new Map<number, string>();
	bytesWritten = 0;
	async load() {
		return this.manifest ? (JSON.parse(this.manifest) as IndexManifest | IndexData) : null;
	}
	async save(d: IndexData) {
		this.manifest = JSON.stringify(d);
		this.bytesWritten += this.manifest.length;
	}
	async loadShard(i: number) {
		const s = this.shards.get(i);
		return s ? (JSON.parse(s) as Record<string, StoredFile>) : null;
	}
	async saveShard(i: number, files: Record<string, StoredFile>) {
		const s = JSON.stringify(files);
		this.shards.set(i, s);
		this.bytesWritten += s.length;
	}
	async saveManifest(m: IndexManifest) {
		this.manifest = JSON.stringify(m);
	}
	size() {
		let n = this.manifest?.length ?? 0;
		for (const s of this.shards.values()) n += s.length;
		return n;
	}
}

const mb = (n: number) => Math.round(n / 1024 / 1024);
async function timed<T>(fn: () => Promise<T> | T): Promise<[T, number]> {
	const t = performance.now();
	const out = await fn();
	return [out, Math.round(performance.now() - t)];
}
function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

async function run(n: number) {
	const row: Record<string, number | string> = { notes: n };
	const [vault, genMs] = await timed(() => makeVault(n));
	row.generateMs = genMs;
	const embedder = new FakeEmbedder();
	const store = new MemStore();
	const opts = { getModel: () => "fake-768", isEnabled: () => true, shouldIndex: () => true };
	let index = new SemanticIndex(embedder as unknown as OllamaClient, vault, store, opts);
	globalThis.gc?.();
	const heap0 = process.memoryUsage().heapUsed;

	const [, buildMs] = await timed(() => index.syncAll());
	row.buildMs = buildMs;
	if (index.status().lastError) row.buildError = String(index.status().lastError);
	row.chunks = index.status().totalChunks;
	row.indexFileMB = mb(store.size());
	row.largestFileMB = mb(Math.max(store.manifest?.length ?? 0, ...Array.from(store.shards.values(), (s) => s.length)));

	// A second sync with nothing changed (what happens at every start-up).
	row.resyncMs = (await timed(() => index.syncAll()))[1];

	// One edited note: re-chunk, embed the changed chunk, save.
	const first = vault.listNotes()[Math.floor(n / 2)].path;
	store.bytesWritten = 0;
	await vault.modify(first, (await vault.read(first)) + "\nAn added line about harbor relay quorum.\n");
	const [, editMs] = await timed(async () => {
		index.enqueue(first);
		await new Promise((r) => setTimeout(r, 0));
		while (index.status().building) await new Promise((r) => setTimeout(r, 5));
		await index.flush();
	});
	row.editOneNoteMs = editMs;
	row.editWritesMB = Math.round((store.bytesWritten / 1024 / 1024) * 10) / 10;

	// Start-up: load the saved index into memory.
	index = new SemanticIndex(embedder as unknown as OllamaClient, vault, store, opts);
	row.loadMs = (await timed(() => index.load()))[1];
	globalThis.gc?.();
	row.heapMB = mb(process.memoryUsage().heapUsed - heap0);
	row.arrayBuffersMB = mb(process.memoryUsage().arrayBuffers);

	const queries = ["gradient torque compiler", "where did I write about the harbor relay quorum", "enzyme membrane voltage", "treaty sonata", "nebula oxide prism quartz"];
	const sem: number[] = [];
	const pas: number[] = [];
	const kw: number[] = [];
	const kwMem: number[] = [];
	const textFor = (index as unknown as { textFor?: (p: string, m: number) => string | undefined }).textFor?.bind(index);
	for (const q of queries) {
		sem.push((await timed(() => index.search(q, 16)))[1]);
		pas.push((await timed(() => index.searchPassages(q, 8)))[1]);
		kw.push((await timed(() => keywordSearch(vault, q, 16)))[1]);
		if (textFor) {
			const notes = vault.listNotes();
			const fromIndex = keywordSearch as unknown as (v: FakeVault, q: string, l: number, n: unknown, t: unknown) => Promise<unknown>;
			kwMem.push((await timed(() => fromIndex(vault, q, 16, notes, (x: { path: string; mtime: number }) => textFor(x.path, x.mtime))))[1]);
		}
	}
	row.semanticQueryMs = median(sem);
	row.passageQueryMs = median(pas);
	row.keywordQueryMs = median(kw);
	if (kwMem.length) row.keywordFromIndexMs = median(kwMem);

	const cfg: AgentConfig = { model: "m", numCtx: 32768, temperature: 0.6, keepAlive: "10m", maxIterations: 60, maxToolResultChars: 12000, autoApprove: true, autoContinue: true, extraSystemPrompt: "" };
	const [sys, sysMs] = await timed(() => buildSystemPrompt(vault, cfg));
	row.systemPromptMs = sysMs;
	row.systemPromptChars = sys.length;
	row.grepMs = (await timed(() => grepVault.execute({ pattern: "harbor relay quorum" }, { vault, search: async () => [], approve: async () => "approve", maxResultChars: 12000 })))[1];
	row.gardenMs = (await timed(() => gardenVault(vault, {})))[1];
	return row;
}

async function realEmbedRate() {
	const sample = Number(process.env.SAMPLE ?? 300);
	const vault = makeVault(sample);
	const client = new OllamaClient(() => process.env.OLLAMA_URL ?? "http://localhost:11434", (...a) => fetch(...a));
	const model = process.env.EMBED_MODEL ?? "nomic-embed-text";
	const index = new SemanticIndex(client, vault, new MemStore(), { getModel: () => model, isEnabled: () => true, shouldIndex: () => true });
	const [, ms] = await timed(() => index.syncAll());
	const s = index.status();
	if (s.lastError) throw new Error(s.lastError);
	return { model, notes: s.indexedFiles, chunks: s.totalChunks, seconds: Math.round(ms / 100) / 10, chunksPerSecond: Math.round(s.totalChunks / (ms / 1000)) };
}

async function main() {
	const rows = [];
	for (const n of SIZES) {
		console.log(`\n=== ${n} notes`);
		const row = await run(n);
		rows.push(row);
		for (const [k, v] of Object.entries(row)) console.log(`${k.padEnd(22)} ${v}`);
		globalThis.gc?.();
	}
	let real: unknown = null;
	if (process.env.EMBED === "real") {
		real = await realEmbedRate();
		console.log("\n=== real embedding model", JSON.stringify(real));
	}
	const tag = process.env.TAG ?? "scale";
	mkdirSync(join(process.cwd(), "bench"), { recursive: true });
	const file = join(process.cwd(), "bench", `${tag}.json`);
	writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), node: process.version, rows, realEmbedding: real }, null, 2) + "\n");
	console.log(`saved ${file}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
