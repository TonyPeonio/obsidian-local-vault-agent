import { chunkMarkdown } from "./chunker";
import type { OllamaClient } from "./ollama";
import type { Passage, SearchHit, VaultAccess } from "./types";

/**
 * Semantic index: embeds note chunks with an Ollama embedding model and answers
 * cosine-similarity queries. Persistence is delegated to a `store` so this file has no
 * Obsidian dependency.
 */

interface StoredChunk {
	heading: string;
	text: string;
	/** Base64-encoded Float32Array. */
	vec: string;
}

interface StoredFile {
	mtime: number;
	chunks: StoredChunk[];
}

export interface IndexData {
	version: 1;
	model: string;
	dims: number;
	files: Record<string, StoredFile>;
}

export interface IndexStore {
	load(): Promise<IndexData | null>;
	save(data: IndexData): Promise<void>;
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

const EMPTY = (model: string): IndexData => ({ version: 1, model, dims: 0, files: {} });

function encodeVec(v: number[]): string {
	const f = new Float32Array(v);
	const bytes = new Uint8Array(f.buffer);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
	}
	return btoa(bin);
}

function decodeVec(s: string): Float32Array {
	const bin = atob(s);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Float32Array(bytes.buffer);
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
	private data: IndexData;
	private decoded = new Map<string, Float32Array[]>();
	private queue = new Set<string>();
	private processing = false;
	private building = false;
	private lastError: string | undefined;
	private saveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
	private abort: AbortController | null = null;
	private dirty = false;

	constructor(
		private client: OllamaClient,
		private vault: VaultAccess,
		private store: IndexStore,
		private opts: IndexOptions,
	) {
		this.data = EMPTY(opts.getModel());
	}

	async load(): Promise<void> {
		try {
			const loaded = await this.store.load();
			if (loaded && loaded.version === 1 && loaded.model === this.opts.getModel()) {
				this.data = loaded;
				this.decoded.clear();
			}
		} catch (err) {
			this.lastError = `Could not load index: ${(err as Error).message}`;
		}
		this.emit();
	}

	status(): IndexStatus {
		let totalChunks = 0;
		for (const f of Object.values(this.data.files)) totalChunks += f.chunks.length;
		return {
			enabled: this.opts.isEnabled(),
			building: this.building || this.processing,
			indexedFiles: Object.keys(this.data.files).length,
			totalChunks,
			pending: this.queue.size,
			lastError: this.lastError,
		};
	}

	get ready(): boolean {
		return this.opts.isEnabled() && Object.keys(this.data.files).length > 0;
	}

	/** Queue every note whose mtime changed or that is missing from the index. */
	async syncAll(force = false): Promise<void> {
		if (!this.opts.isEnabled()) return;
		if (force || this.data.model !== this.opts.getModel()) {
			this.data = EMPTY(this.opts.getModel());
			this.decoded.clear();
			this.dirty = true;
		}
		const live = new Set<string>();
		for (const note of this.vault.listNotes()) {
			if (!this.opts.shouldIndex(note.path)) continue;
			live.add(note.path);
			const stored = this.data.files[note.path];
			if (!stored || stored.mtime !== note.mtime) this.queue.add(note.path);
		}
		for (const path of Object.keys(this.data.files)) {
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
		if (this.data.files[path]) {
			delete this.data.files[path];
			this.decoded.delete(path);
			this.dirty = true;
			this.scheduleSave();
		}
		this.queue.delete(path);
		this.emit();
	}

	rename(oldPath: string, newPath: string): void {
		const entry = this.data.files[oldPath];
		this.remove(oldPath);
		if (entry && this.opts.shouldIndex(newPath)) {
			this.data.files[newPath] = entry;
			this.dirty = true;
			this.scheduleSave();
		}
		this.emit();
	}

	async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
		if (!this.ready) return [];
		const model = this.opts.getModel();
		const [qv] = await this.client.embed(model, [embedInput(model, query, "query")], signal);
		const q = new Float32Array(qv);
		const hits: (SearchHit & { chunkIndex: number })[] = [];
		for (const [path, file] of Object.entries(this.data.files)) {
			const vecs = this.vectorsFor(path, file);
			let best = -1;
			let bestIdx = -1;
			for (let i = 0; i < vecs.length; i++) {
				const s = cosine(q, vecs[i]);
				if (s > best) {
					best = s;
					bestIdx = i;
				}
			}
			if (bestIdx >= 0) {
				const chunk = file.chunks[bestIdx];
				hits.push({
					path,
					score: best,
					heading: chunk.heading || undefined,
					snippet: chunk.text.replace(/\s+/g, " ").slice(0, 280),
					chunkIndex: bestIdx,
				});
			}
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit).map(({ chunkIndex, ...h }) => h);
	}

	/**
	 * Chunk-level search: the best-matching sections across the vault, verbatim, at most
	 * `perNote` from any one note so a single long note cannot crowd out the others.
	 */
	async searchPassages(query: string, limit: number, perNote = 3, signal?: AbortSignal): Promise<Passage[]> {
		if (!this.ready) return [];
		const model = this.opts.getModel();
		const [qv] = await this.client.embed(model, [embedInput(model, query, "query")], signal);
		const q = new Float32Array(qv);
		const scored: (Passage & { index: number })[] = [];
		for (const [path, file] of Object.entries(this.data.files)) {
			const vecs = this.vectorsFor(path, file);
			const mine: (Passage & { index: number })[] = [];
			for (let i = 0; i < vecs.length; i++) {
				const chunk = file.chunks[i];
				mine.push({ path, heading: chunk.heading, text: chunk.text, score: cosine(q, vecs[i]), index: i });
			}
			mine.sort((a, b) => b.score - a.score);
			scored.push(...mine.slice(0, perNote));
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit).map(({ index, ...p }) => p);
	}

	private vectorsFor(path: string, file: StoredFile): Float32Array[] {
		let vecs = this.decoded.get(path);
		if (!vecs) {
			vecs = file.chunks.map((c) => decodeVec(c.vec));
			this.decoded.set(path, vecs);
		}
		return vecs;
	}

	private async process(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		this.abort = new AbortController();
		const signal = this.abort.signal;
		const batchSize = this.opts.batchSize ?? 16;
		try {
			while (this.queue.size > 0 && !signal.aborted) {
				const path = this.queue.values().next().value as string;
				this.queue.delete(path);
				if (!this.vault.exists(path)) {
					this.remove(path);
					continue;
				}
				const note = this.vault.listNotes().find((n) => n.path === path);
				const content = await this.vault.read(path);
				const model = this.opts.getModel();
				const chunks = chunkMarkdown(content);
				const inputs = chunks.map((c) =>
					embedInput(model, `${noteTitle(path)}${c.heading ? ` > ${c.heading}` : ""}\n${c.text}`, "document"),
				);
				const vectors: number[][] = [];
				for (let i = 0; i < inputs.length; i += batchSize) {
					const batch = inputs.slice(i, i + batchSize);
					vectors.push(...(await this.client.embed(model, batch, signal)));
				}
				if (vectors.length && this.data.dims === 0) this.data.dims = vectors[0].length;
				this.data.files[path] = {
					mtime: note?.mtime ?? Date.now(),
					chunks: chunks.map((c, i) => ({ heading: c.heading, text: c.text, vec: encodeVec(vectors[i]) })),
				};
				this.decoded.delete(path);
				this.dirty = true;
				this.lastError = undefined;
				this.scheduleSave();
				this.emit();
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
		if (this.saveTimer !== null) globalThis.clearTimeout(this.saveTimer);
		this.saveTimer = globalThis.setTimeout(() => void this.flush(), 3000);
	}

	async flush(): Promise<void> {
		if (this.saveTimer !== null) {
			globalThis.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.dirty) return;
		this.dirty = false;
		try {
			await this.store.save(this.data);
		} catch (err) {
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
