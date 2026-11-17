import { chunkMarkdown } from "./chunker";
import type { OllamaClient } from "./ollama";
import type { Passage, SearchHit, VaultAccess } from "./types";

/**
 * Semantic index: embeds note chunks with an Ollama embedding model and answers
 * cosine-similarity queries. Persistence is delegated to a `store` so this file has no
 * Obsidian dependency.
 */

export interface StoredChunk {
	heading: string;
	text: string;
	/** Base64-encoded Float32Array. */
	vec: string;
}

export interface StoredFile {
	mtime: number;
	chunks: StoredChunk[];
}

export interface IndexData {
	version: 1;
	model: string;
	dims: number;
	files: Record<string, StoredFile>;
}

/** How many files the index is split over when the store supports shards. */
export const SHARDS = 32;

/** The small file that says what the shard files hold (sharded stores). */
export interface IndexManifest {
	version: 2;
	model: string;
	dims: number;
	shards: number;
}

/**
 * Where the index is kept. `load`/`save` handle it as one document (small vaults in tests and
 * scripts, and indexes saved by versions before 0.8.0). A store that also has the shard methods
 * keeps it as `SHARDS` files plus a manifest: one edited note then rewrites one shard, not the
 * whole index, and no single string has to hold every vector (at 50,000 notes the one-file form
 * is past what a JavaScript string can be).
 */
export interface IndexStore {
	load(): Promise<IndexData | IndexManifest | null>;
	save(data: IndexData): Promise<void>;
	loadShard?(shard: number): Promise<Record<string, StoredFile> | null>;
	saveShard?(shard: number, files: Record<string, StoredFile>): Promise<void>;
	saveManifest?(manifest: IndexManifest): Promise<void>;
}

export interface IndexStatus {
	enabled: boolean;
	building: boolean;
	indexedFiles: number;
	totalChunks: number;
	pending: number;
	lastError?: string;
}

export interface IndexOptions {
	getModel: () => string;
	isEnabled: () => boolean;
	shouldIndex: (path: string) => boolean;
	onStatus?: (status: IndexStatus) => void;
	/** Max chunks per embedding request. */
	batchSize?: number;
}

function encodeVec(f: Float32Array): string {
	const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
	}
	return btoa(bin);
}

function decodeVec(s: string): Float32Array {
	const bin = atob(s);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Float32Array(bytes.buffer);
}

/** Scales a vector to unit length in place, so similarity is a plain dot product. */
function normalize(v: Float32Array): Float32Array {
	let n = 0;
	for (let i = 0; i < v.length; i++) n += v[i] * v[i];
	n = Math.sqrt(n);
	if (n > 0 && Math.abs(n - 1) > 1e-6) for (let i = 0; i < v.length; i++) v[i] /= n;
	return v;
}

function dot(a: Float32Array, b: Float32Array): number {
	let d = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) d += a[i] * b[i];
	return d;
}

/** Which shard a note's entry lives in (FNV-1a of the path). */
export function shardOf(path: string, shards = SHARDS): number {
	let h = 2166136261;
	for (let i = 0; i < path.length; i++) {
		h ^= path.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h % shards;
}

/** A chunk in memory: its vector as numbers (unit length), not base64. */
interface MemChunk {
	heading: string;
	text: string;
	vec: Float32Array;
}

interface MemFile {
	mtime: number;
	chunks: MemChunk[];
}

export function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** nomic-embed models want task prefixes; other models are passed through unchanged. */
export function embedInput(model: string, text: string, kind: "query" | "document"): string {
	if (/nomic-embed/i.test(model)) {
		return `${kind === "query" ? "search_query" : "search_document"}: ${text}`;
	}
	return text;
}

export class SemanticIndex {
	private model: string;
	private dims = 0;
	private files = new Map<string, MemFile>();
	/** Kept in step with `files`, so status() costs nothing however large the vault is. */
	private totalChunks = 0;
	private queue = new Set<string>();
	private processing = false;
	private building = false;
	private lastError: string | undefined;
	private saveTimer: number | null = null;
	private abort: AbortController | null = null;
	private dirty = false;
	private dirtyShards = new Set<number>();
	private lastFlush = Date.now();

	constructor(
		private client: OllamaClient,
		private vault: VaultAccess,
		private store: IndexStore,
		private opts: IndexOptions,
	) {
		this.model = opts.getModel();
	}

	private get sharded(): boolean {
		return !!(this.store.loadShard && this.store.saveShard && this.store.saveManifest);
	}

	private setFile(path: string, file: MemFile | null): void {
		const old = this.files.get(path);
		if (old) this.totalChunks -= old.chunks.length;
		if (file) {
			this.files.set(path, file);
			this.totalChunks += file.chunks.length;
		} else this.files.delete(path);
		this.dirty = true;
		this.dirtyShards.add(shardOf(path));
	}

	private clear(): void {
		this.files.clear();
		this.totalChunks = 0;
		this.dims = 0;
		this.model = this.opts.getModel();
		this.dirty = true;
		for (let i = 0; i < SHARDS; i++) this.dirtyShards.add(i);
	}

	private adopt(files: Record<string, StoredFile>): void {
		for (const [path, f] of Object.entries(files)) {
			const chunks = f.chunks.map((c) => ({ heading: c.heading, text: c.text, vec: normalize(decodeVec(c.vec)) }));
			this.files.set(path, { mtime: f.mtime, chunks });
			this.totalChunks += chunks.length;
		}
	}

	async load(): Promise<void> {
		try {
			const loaded = await this.store.load();
			if (loaded && loaded.model === this.opts.getModel()) {
				this.files.clear();
				this.totalChunks = 0;
				this.model = loaded.model;
				this.dims = loaded.dims;
				if (loaded.version === 2) {
					if (!this.store.loadShard) throw new Error("the index is stored in shards this build cannot read");
					for (let i = 0; i < loaded.shards; i++) {
						const shard = await this.store.loadShard(i);
						if (shard) this.adopt(shard);
					}
					// Another shard count (a future build's): rewrite everything in this build's layout.
					if (loaded.shards !== SHARDS) {
						this.dirty = true;
						for (let i = 0; i < SHARDS; i++) this.dirtyShards.add(i);
					}
				} else if (loaded.version === 1) {
					this.adopt(loaded.files);
					// An index from before 0.8.0 (one file): move it into shards on the next save.
					if (this.sharded) {
						this.dirty = true;
						for (let i = 0; i < SHARDS; i++) this.dirtyShards.add(i);
						this.scheduleSave();
					}
				}
			}
		} catch (err) {
			this.lastError = `Could not load index: ${(err as Error).message}`;
		}
		this.emit();
	}

	status(): IndexStatus {
		return {
			enabled: this.opts.isEnabled(),
			building: this.building || this.processing,
			indexedFiles: this.files.size,
			totalChunks: this.totalChunks,
			pending: this.queue.size,
			lastError: this.lastError,
		};
	}

	get ready(): boolean {
		return this.opts.isEnabled() && this.files.size > 0;
	}

	/** The indexed text of a note (its chunks joined), when its index entry is current; for keyword search without a disk read. */
	textFor(path: string, mtime: number): string | undefined {
		const f = this.files.get(path);
		if (!f || f.mtime !== mtime) return undefined;
		return f.chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)).join("\n");
	}

	/** Queue every note whose mtime changed or that is missing from the index. */
	async syncAll(force = false): Promise<void> {
		if (!this.opts.isEnabled()) return;
		if (force || this.model !== this.opts.getModel()) this.clear();
		const live = new Set<string>();
		for (const note of this.vault.listNotes()) {
			if (!this.opts.shouldIndex(note.path)) continue;
			live.add(note.path);
			const stored = this.files.get(note.path);
			if (!stored || stored.mtime !== note.mtime) this.queue.add(note.path);
		}
		for (const path of Array.from(this.files.keys())) {
			if (!live.has(path)) this.remove(path);
		}
		this.building = this.queue.size > 0;
		this.emit();
		await this.process();
	}

	/** Cancel in-flight embedding work. Queued files are kept for the next sync. */
	cancel(): void {
		this.abort?.abort();
	}

	enqueue(path: string): void {
		if (!this.opts.isEnabled() || !this.opts.shouldIndex(path)) return;
		this.queue.add(path);
		void this.process();
	}

	remove(path: string): void {
		if (this.files.has(path)) {
			this.setFile(path, null);
			this.scheduleSave();
		}
		this.queue.delete(path);
		this.emit();
	}

	rename(oldPath: string, newPath: string): void {
		const entry = this.files.get(oldPath);
		this.remove(oldPath);
		if (entry && this.opts.shouldIndex(newPath)) {
			this.setFile(newPath, entry);
			this.scheduleSave();
		}
		this.emit();
	}

	private async queryVector(query: string, signal?: AbortSignal): Promise<Float32Array> {
		const model = this.opts.getModel();
		const [qv] = await this.client.embed(model, [embedInput(model, query, "query")], signal);
		return normalize(new Float32Array(qv));
	}

	async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
		if (!this.ready) return [];
		const q = await this.queryVector(query, signal);
		// Only the best chunk per note, and only numbers until the top `limit` are known: at 50,000
		// notes, building a hit object with a snippet for every note was most of the query time.
		const best: { path: string; score: number; idx: number }[] = [];
		for (const [path, file] of this.files) {
			let top = -2;
			let idx = -1;
			for (let i = 0; i < file.chunks.length; i++) {
				const s = dot(q, file.chunks[i].vec);
				if (s > top) {
					top = s;
					idx = i;
				}
			}
			if (idx >= 0) best.push({ path, score: top, idx });
		}
		best.sort((a, b) => b.score - a.score);
		return best.slice(0, limit).map((b) => {
			const chunk = this.files.get(b.path)!.chunks[b.idx];
			return { path: b.path, score: b.score, heading: chunk.heading || undefined, snippet: chunk.text.replace(/\s+/g, " ").slice(0, 280) };
		});
	}

	/**
	 * Chunk-level search: the best-matching sections across the vault, verbatim, at most
	 * `perNote` from any one note so a single long note cannot crowd out the others.
	 */
	async searchPassages(query: string, limit: number, perNote = 3, signal?: AbortSignal): Promise<Passage[]> {
		if (!this.ready) return [];
		const q = await this.queryVector(query, signal);
		const scored: { path: string; score: number; idx: number }[] = [];
		for (const [path, file] of this.files) {
			const mine: { path: string; score: number; idx: number }[] = [];
			for (let i = 0; i < file.chunks.length; i++) mine.push({ path, score: dot(q, file.chunks[i].vec), idx: i });
			if (mine.length > perNote) mine.sort((a, b) => b.score - a.score);
			for (let i = 0; i < Math.min(perNote, mine.length); i++) scored.push(mine[i]);
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit).map((s) => {
			const chunk = this.files.get(s.path)!.chunks[s.idx];
			return { path: s.path, heading: chunk.heading, text: chunk.text, score: s.score };
		});
	}

	/** One unit vector per indexed note: the normalised mean of its chunk vectors. */
	noteVectors(): Map<string, Float32Array> {
		const out = new Map<string, Float32Array>();
		for (const [path, file] of this.files) {
			if (file.chunks.length === 0) continue;
			const sum = new Float32Array(file.chunks[0].vec.length);
			for (const c of file.chunks) for (let i = 0; i < sum.length; i++) sum[i] += c.vec[i];
			out.set(path, normalize(sum));
		}
		return out;
	}

	private async process(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		this.abort = new AbortController();
		const signal = this.abort.signal;
		const batchSize = this.opts.batchSize ?? 64;
		// One pass over the vault for modification times, not one per queued note: looking each note
		// up in the full list made a first index of N notes cost N² (25 minutes of nothing at 50,000).
		let mtimes: Map<string, number> | null = null;
		const mtimeOf = (path: string): number | undefined => {
			if (this.queue.size < 8 && !mtimes) return this.vault.listNotes().find((n) => n.path === path)?.mtime;
			mtimes ??= new Map(this.vault.listNotes().map((n) => [n.path, n.mtime]));
			return mtimes.get(path) ?? this.vault.listNotes().find((n) => n.path === path)?.mtime;
		};
		let lastEmit = 0;
		try {
			while (this.queue.size > 0 && !signal.aborted) {
				const path = this.queue.values().next().value as string;
				this.queue.delete(path);
				if (!this.vault.exists(path)) {
					this.remove(path);
					continue;
				}
				const mtime = mtimeOf(path);
				const content = await this.vault.read(path);
				const model = this.opts.getModel();
				const chunks = chunkMarkdown(content);
				// A chunk whose heading and text are unchanged keeps its vector; only new or edited
				// chunks go to the embedding model. A note that grows a paragraph at a time (a lecture
				// being transcribed, a daily note being typed) otherwise had every chunk embedded again
				// on each save, which on a laptop is a GPU burst every few seconds for nothing.
				const chunkKey = (c: { heading: string; text: string }) => `${c.heading}\n${c.text}`;
				const known = new Map<string, Float32Array>();
				for (const c of this.files.get(path)?.chunks ?? []) known.set(chunkKey(c), c.vec);
				const vecs: (Float32Array | undefined)[] = chunks.map((c) => known.get(chunkKey(c)));
				const missing = chunks.map((_, i) => i).filter((i) => vecs[i] === undefined);
				const inputs = missing.map((i) =>
					embedInput(model, `${noteTitle(path)}${chunks[i].heading ? ` > ${chunks[i].heading}` : ""}\n${chunks[i].text}`, "document"),
				);
				for (let i = 0; i < inputs.length; i += batchSize) {
					const vectors = await this.client.embed(model, inputs.slice(i, i + batchSize), signal);
					if (vectors.length && this.dims === 0) this.dims = vectors[0].length;
					vectors.forEach((v, k) => (vecs[missing[i + k]] = normalize(new Float32Array(v))));
				}
				this.setFile(path, { mtime: mtime ?? Date.now(), chunks: chunks.map((c, i) => ({ heading: c.heading, text: c.text, vec: vecs[i] as Float32Array })) });
				this.lastError = undefined;
				this.scheduleSave();
				// During a long build: tell listeners a few times a second, not once per note, and put
				// what is done on disk every minute so a crash or a closed laptop does not lose it.
				const now = Date.now();
				if (now - lastEmit > 250 || this.queue.size === 0) {
					lastEmit = now;
					this.emit();
				}
				if (this.sharded && now - this.lastFlush > 60_000) await this.flush();
			}
		} catch (err) {
			if (!signal.aborted) this.lastError = (err as Error).message;
		} finally {
			this.processing = false;
			this.building = false;
			this.abort = null;
			this.emit();
			await this.flush();
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.flush(), 3000);
	}

	private stored(file: MemFile): StoredFile {
		return { mtime: file.mtime, chunks: file.chunks.map((c) => ({ heading: c.heading, text: c.text, vec: encodeVec(c.vec) })) };
	}

	async flush(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.dirty) return;
		this.dirty = false;
		this.lastFlush = Date.now();
		const shards = Array.from(this.dirtyShards);
		this.dirtyShards.clear();
		try {
			if (this.sharded) {
				// Only the shards that changed are written; each is built and released in turn.
				const want = new Set(shards);
				const buckets = new Map<number, Record<string, StoredFile>>(shards.map((i) => [i, {}]));
				for (const [path, file] of this.files) {
					const i = shardOf(path);
					if (want.has(i)) buckets.get(i)![path] = this.stored(file);
				}
				for (const i of shards) {
					await this.store.saveShard!(i, buckets.get(i)!);
					buckets.delete(i);
				}
				await this.store.saveManifest!({ version: 2, model: this.model, dims: this.dims, shards: SHARDS });
			} else {
				const files: Record<string, StoredFile> = {};
				for (const [path, file] of this.files) files[path] = this.stored(file);
				await this.store.save({ version: 1, model: this.model, dims: this.dims, files });
			}
		} catch (err) {
			this.dirty = true;
			for (const i of shards) this.dirtyShards.add(i);
			this.lastError = `Could not save index: ${(err as Error).message}`;
			this.emit();
		}
	}

	private emit(): void {
		this.opts.onStatus?.(this.status());
	}
}

function noteTitle(path: string): string {
	const base = path.split("/").pop() ?? path;
	return base.replace(/\.md$/i, "");
}
