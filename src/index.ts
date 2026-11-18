import { chunkMarkdown } from "./chunker";
import type { OllamaClient } from "./ollama";
import { LexicalIndex, absentFrom, dateTerms, fuseKeyed } from "./retrieval";
import { queryTerms, snippetNear } from "./search";
import type { Passage, SearchHit, VaultAccess } from "./types";

/**
 * Semantic index: embeds note chunks with an Ollama embedding model and answers
 * cosine-similarity queries. Persistence is delegated to a `store` so this file has no
 * Obsidian dependency.
 */

export interface StoredChunk {
	heading: string;
	/** The heading with its parent headings (see `Chunk.crumb`); absent in indexes saved before 0.9.0. */
	crumb?: string;
	text: string;
	/** Base64-encoded Float32Array. */
	vec: string;
}

/**
 * What a chunk's vector was computed from. 2 (0.9.0): the note title and the heading PATH, where
 * 1 used the title and the nearest heading only. A stored note with another value is chunked
 * again on the next sync; chunks whose embedded text did not change keep their vectors.
 */
export const EMBED_FORMAT = 2;

export interface StoredFile {
	mtime: number;
	chunks: StoredChunk[];
	/** `EMBED_FORMAT` the chunks were embedded with; absent means 1. */
	fmt?: number;
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
	/** The current time, for questions that name a day ("yesterday", "September 10"); the clock by default. */
	now?: () => Date;
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
	crumb: string;
	text: string;
	vec: Float32Array;
}

/** A stored note from an older embed format is given this mtime, which no real note has, so the next sync chunks it again. */
const STALE_MTIME = -1;

/**
 * Before a word is said to be in no note, the notes the index has not read in their current
 * version are read and searched for it. That is done for up to this many notes and this much
 * text; past either (a first index under way, the embedding server down for a whole vault) the
 * statement is not made at all.
 */
export const UNREAD_CHECK_NOTES = 100;
export const UNREAD_CHECK_CHARS = 2_000_000;

export interface PassageSearchOptions {
	/** false: embeddings only, as before 0.9.0. Default: embeddings and word matching together. */
	lexical?: boolean;
	/** How the two scores are combined: "blend" (default) mixes the normalised scores, "rrf" fuses the ranks. */
	fusion?: "blend" | "rrf";
	/** The say of word matching: its share of the mix for "blend" (default 0.3), its weight for "rrf" (default 1). */
	lexWeight?: number;
	/** Added to a passage that contains every word of the question ("blend" only; default 0.45: enough for the best such passage to pass the best by meaning alone). */
	coverBonus?: number;
	/** false: do not look for days the question names. */
	dates?: boolean;
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

/**
 * The cosine score under which the best passage is "not a close match", for embedding models it
 * has been measured on (`npm run bench:retrieval`: with nomic-embed-text every question the
 * benchmark vault cannot answer scored under 0.68 and 93% of the answerable ones over it; 0.64
 * leaves a margin, so a real match is not called weak). Undefined for other models: their scores
 * are on another scale.
 */
export function weakMatchThreshold(model: string): number | undefined {
	return /nomic-embed-text/i.test(model) ? 0.64 : undefined;
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
	/**
	 * Notes whose current text the index does not hold: created or edited since it last read them,
	 * waiting in the queue, or not embedded because the server did not answer. Path → a mark that
	 * changes with every new edit, so an indexing pass that read the older text does not clear it.
	 * Kept from vault events and from `syncAll`, so it costs nothing per search and is as large as
	 * what is out of date, not as the vault.
	 */
	private unread = new Map<string, number>();
	private unreadSeq = 0;
	/** Whether the index has been compared with the vault (`syncAll`) since it was loaded or switched on: before that, what it lacks is unknown. */
	private compared = false;
	private processing = false;
	/** The indexing pass under way, or the last one. */
	private running: Promise<void> = Promise.resolve();
	private building = false;
	private lastError: string | undefined;
	private saveTimer: number | null = null;
	private abort: AbortController | null = null;
	private dirty = false;
	private dirtyShards = new Set<number>();
	private lastFlush = Date.now();
	/** Model, dimensions and shard count of the manifest on disk, so an unchanged one is not written again. */
	private manifestKey = "";
	/** The flush in progress: flushes run one after another, never side by side. */
	private flushing: Promise<void> = Promise.resolve();
	/**
	 * Word index over the same chunks; needs no model. Built on the first search, not at start-up
	 * (at 50,000 notes it takes seconds and a hundred megabytes that a session without a question
	 * never needs), and kept in step with `files` from then on.
	 */
	private lex = new LexicalIndex();
	private lexBuilt = false;
	private lexBuilding: Promise<void> | null = null;
	/** Notes that changed while the word index was being built; brought up to date when it is done. */
	private lexStale = new Set<string>();

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
		this.lexUpdate(path);
		this.dirty = true;
		this.dirtyShards.add(shardOf(path));
	}

	/** Brings the word index's entry for one note in line with `files` (once the index exists). */
	private lexUpdate(path: string): void {
		if (this.lexBuilding) this.lexStale.add(path);
		if (!this.lexBuilt) return;
		const file = this.files.get(path);
		if (file) this.lex.setFile(path, file.chunks.map((c) => ({ heading: c.crumb, text: c.text })), noteTitle(path));
		else this.lex.remove(path);
	}

	/** Builds the word index from what is in memory, in slices, so a large vault does not freeze the window. */
	private ensureLex(): Promise<void> {
		if (this.lexBuilt) return Promise.resolve();
		this.lexBuilding ??= (async () => {
			this.lex.clear();
			this.lexStale.clear();
			let n = 0;
			for (const [path, file] of Array.from(this.files)) {
				this.lex.setFile(path, file.chunks.map((c) => ({ heading: c.crumb, text: c.text })), noteTitle(path));
				if (++n % 400 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			}
			this.lexBuilt = true;
			this.lexBuilding = null;
			// Notes that were edited, added or removed meanwhile.
			for (const path of this.lexStale) this.lexUpdate(path);
			this.lexStale.clear();
		})();
		return this.lexBuilding;
	}

	private clear(): void {
		this.files.clear();
		this.lex.clear();
		this.lexBuilt = false;
		this.lexStale.clear();
		this.totalChunks = 0;
		this.dims = 0;
		this.model = this.opts.getModel();
		this.dirty = true;
		for (let i = 0; i < SHARDS; i++) this.dirtyShards.add(i);
	}

	private adopt(files: Record<string, StoredFile>): void {
		for (const [path, f] of Object.entries(files)) {
			const chunks = f.chunks.map((c) => ({ heading: c.heading, crumb: c.crumb ?? c.heading, text: c.text, vec: normalize(decodeVec(c.vec)) }));
			// An older embed format stays searchable as it is, and is chunked again on the next sync.
			this.files.set(path, { mtime: (f.fmt ?? 1) === EMBED_FORMAT ? f.mtime : STALE_MTIME, chunks });
			this.totalChunks += chunks.length;
			this.lexUpdate(path);
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
						try {
							const shard = await this.store.loadShard(i);
							if (shard) this.adopt(shard);
						} catch (err) {
							// One unreadable shard (a write cut short by a crash) costs only its own notes:
							// syncAll embeds them again, and the next save replaces the bad file.
							this.lastError = `Could not load index: part ${i} is unreadable (${(err as Error).message})`;
							this.dirty = true;
							if (i < SHARDS) this.dirtyShards.add(i);
						}
					}
					// Another shard count (a future build's): rewrite everything in this build's layout.
					if (loaded.shards !== SHARDS) {
						this.dirty = true;
						for (let i = 0; i < SHARDS; i++) this.dirtyShards.add(i);
					} else this.manifestKey = `${loaded.model}|${loaded.dims}|${SHARDS}`;
				} else if (loaded.version === 1) {
					this.adopt(loaded.files);
					// An index from before 0.8.0 (one file): move it into shards on the next save.
					if (this.sharded) {
						this.dirty = true;
						for (let i = 0; i < SHARDS; i++) this.dirtyShards.add(i);
						this.scheduleSave();
					}
				}
			} else if (loaded && this.sharded) {
				// A stored index for another model: its shard files must not outlive the first save of
				// the new one, or their old vectors are loaded as current next time. Not marked dirty,
				// so nothing is written (and the old index survives) until a note is embedded.
				for (let i = 0; i < SHARDS; i++) this.dirtyShards.add(i);
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
			if (!stored || stored.mtime !== note.mtime) {
				this.queue.add(note.path);
				if (!this.unread.has(note.path)) this.unread.set(note.path, ++this.unreadSeq);
			}
		}
		for (const path of Array.from(this.files.keys())) {
			if (!live.has(path)) this.remove(path);
		}
		// A note marked unread that is gone, or no longer indexed (its folder was excluded), is nobody's to read.
		for (const path of Array.from(this.unread.keys())) {
			if (!live.has(path)) this.unread.delete(path);
		}
		this.compared = true;
		this.building = this.queue.size > 0;
		this.emit();
		await this.process();
	}

	/** Cancel in-flight embedding work. Queued files are kept for the next sync. */
	cancel(): void {
		this.abort?.abort();
	}

	/**
	 * A note was created or changed just now. Called at once from the vault's events, while
	 * `enqueue` follows after the typing pause: from this moment the index's text of the note is
	 * known to be out of date, so nothing is claimed about the vault's words without reading it.
	 */
	touch(path: string): void {
		if (!this.opts.shouldIndex(path)) return;
		// Switched off, the index does not follow the vault; the next sync finds what changed.
		if (!this.opts.isEnabled()) this.compared = false;
		else this.unread.set(path, ++this.unreadSeq);
	}

	/**
	 * Which notes are indexed has changed (the excluded folders were edited): a folder that was
	 * left out may now be in view with notes the index never read, and no event says which. Until
	 * the next `syncAll` compares the two, nothing is claimed about the vault's words.
	 */
	scopeChanged(): void {
		this.compared = false;
	}

	enqueue(path: string): void {
		if (!this.opts.shouldIndex(path)) return;
		if (!this.opts.isEnabled()) {
			this.compared = false;
			return;
		}
		this.queue.add(path);
		if (!this.unread.has(path)) this.unread.set(path, ++this.unreadSeq);
		void this.process();
	}

	remove(path: string): void {
		if (this.files.has(path)) {
			this.setFile(path, null);
			this.scheduleSave();
		}
		this.queue.delete(path);
		this.unread.delete(path);
		this.emit();
	}

	rename(oldPath: string, newPath: string): void {
		const entry = this.files.get(oldPath);
		// Not read yet under its old name (just created, edited since, or moved in from a folder that is not indexed): not read under the new one either.
		const unread = !entry || this.unread.has(oldPath);
		this.remove(oldPath);
		if (this.opts.shouldIndex(newPath)) {
			if (entry) {
				this.setFile(newPath, entry);
				this.scheduleSave();
			}
			if (unread) this.unread.set(newPath, ++this.unreadSeq);
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
		const terms = queryTerms(query);
		return best.slice(0, limit).map((b) => {
			const chunk = this.files.get(b.path)!.chunks[b.idx];
			return { path: b.path, score: b.score, heading: chunk.crumb || undefined, snippet: snippetNear(chunk.text, terms) };
		});
	}

	/**
	 * Chunk-level search: the best-matching sections across the vault, verbatim, at most
	 * `perNote` from any one note so a single long note cannot crowd out the others. Two scores
	 * are combined: by meaning (embeddings) and by words (BM25 over the same chunks), because an
	 * embedding blurs exactly what notes are full of: names, identifiers, numbers, a rare term.
	 * A question that names a day ("September 10", "yesterday") also keeps places for the
	 * sections and notes dated that day, which neither score finds from the words alone.
	 */
	async searchPassages(query: string, limit: number, perNote = 3, signal?: AbortSignal, opts: PassageSearchOptions = {}): Promise<Passage[]> {
		if (!this.ready) return [];
		const q = await this.queryVector(query, signal);
		const pool = Math.max(limit * 4, 24);
		type Cand = { path: string; idx: number; dense: number; lex: number; words?: { matched: number; terms: number }; dated: boolean; score: number };
		const key = (h: { path: string; idx: number }) => `${h.path}\n${h.idx}`;
		const dense: Cand[] = [];
		for (const [path, file] of this.files) {
			const mine: Cand[] = [];
			for (let i = 0; i < file.chunks.length; i++) mine.push({ path, idx: i, dense: dot(q, file.chunks[i].vec), lex: 0, dated: false, score: 0 });
			if (mine.length > perNote) mine.sort((x, y) => y.dense - x.dense);
			for (let i = 0; i < Math.min(perNote, mine.length); i++) dense.push(mine[i]);
		}
		dense.sort((x, y) => y.dense - x.dense);
		let ranked: Cand[];
		if (opts.lexical === false) ranked = dense.slice(0, limit);
		else {
			await this.ensureLex();
			// "September 10" is `2026-09-10` in a file name or a heading: search the day as notes write it.
			const dates = opts.dates === false ? [] : dateTerms(query, this.opts.now?.() ?? new Date());
			const lexical = this.lex.search(query, pool, (path, idx) => this.files.get(path)?.chunks[idx]?.text, dates);
			const cands = new Map<string, Cand>();
			for (const d of dense.slice(0, pool)) cands.set(key(d), d);
			for (const h of lexical) {
				let c = cands.get(key(h));
				if (!c) {
					const vec = this.files.get(h.path)?.chunks[h.idx]?.vec;
					if (!vec) continue;
					cands.set(key(h), (c = { path: h.path, idx: h.idx, dense: dot(q, vec), lex: 0, dated: false, score: 0 }));
				}
				c.lex = h.score;
				c.words = { matched: h.matched, terms: h.terms };
			}
			const all = Array.from(cands.values());
			if ((opts.fusion ?? "blend") === "rrf") {
				const fused = fuseKeyed(
					[dense.slice(0, pool).map((h) => ({ key: key(h), item: h })), lexical.map((h) => ({ key: key(h), item: cands.get(key(h)) as Cand })).filter((e) => e.item)],
					all.length,
					60,
					[1, opts.lexWeight ?? 1],
				);
				for (const f of fused) f.item.score = f.fused;
			} else {
				// Both scores brought to 0..1 over the candidates, then mixed: unlike rank fusion this keeps
				// "far ahead of the rest", so one passage with the exact rare term is not outvoted by
				// passages that are merely middling on both.
				let dMin = Infinity;
				let dMax = -Infinity;
				let lMax = 0;
				for (const c of all) {
					dMin = Math.min(dMin, c.dense);
					dMax = Math.max(dMax, c.dense);
					lMax = Math.max(lMax, c.lex);
				}
				const w = opts.lexWeight ?? 0.3;
				// A passage with every word of the question is rare for a sentence and decisive for a name or an identifier.
				const cover = opts.coverBonus ?? 0.45;
				for (const c of all) {
					c.score = (1 - w) * (dMax > dMin ? (c.dense - dMin) / (dMax - dMin) : 1) + w * (lMax > 0 ? c.lex / lMax : 0);
					if (c.words && c.words.matched === c.words.terms) c.score += cover;
				}
			}
			all.sort((x, y) => y.score - x.score);
			if (dates.length) {
				for (const c of all) {
					const where = `${c.path}\n${this.files.get(c.path)?.chunks[c.idx]?.crumb ?? ""}`;
					c.dated = dates.some((d) => where.includes(d));
				}
			}
			// Most places go to passages dated the day the question names; the rest are the best of
			// everything, with the per-note limit over both. Dated passages are ranked by their words,
			// not by meaning: the note named after the day comes first, then sections headed by it,
			// and among those the one whose heading or text has the question's other words ("What
			// did I get done on the 21st?" is the "Done" section, which by meaning lost to a to-do
			// list for the next day).
			const taken = new Map<string, number>();
			const picked: Cand[] = [];
			const take = (c: Cand): boolean => {
				const n = taken.get(c.path) ?? 0;
				if (picked.includes(c) || n >= perNote) return false;
				taken.set(c.path, n + 1);
				picked.push(c);
				return true;
			};
			if (dates.length) {
				let reserved = Math.max(Math.ceil(limit / 2), limit - 2);
				for (const c of all.filter((x) => x.dated).sort((x, y) => y.lex - x.lex || y.score - x.score)) {
					if (reserved <= 0) break;
					if (take(c)) reserved--;
				}
			}
			for (const c of all) {
				if (picked.length >= limit) break;
				take(c);
			}
			ranked = picked;
		}
		return ranked.flatMap((r) => {
			const chunk = this.files.get(r.path)?.chunks[r.idx];
			if (!chunk) return [];
			return [{ path: r.path, heading: chunk.heading, crumb: chunk.crumb, text: chunk.text, score: r.dense, words: r.words }];
		});
	}

	/**
	 * Note-level search: the notes whose best passage answers best, ranked exactly as
	 * `searchPassages` ranks passages (meaning and words together, days named in words), each with
	 * the heading path of that passage and the part of it nearest the question's words.
	 */
	async searchNotes(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
		const terms = queryTerms(query);
		return (await this.searchPassages(query, limit, 1, signal)).map((p) => ({ path: p.path, score: p.score, heading: (p.crumb ?? p.heading) || undefined, snippet: snippetNear(p.text, terms) }));
	}

	/** How many notes the index has not read in their current version (see `absentWords`). */
	get unreadCount(): number {
		return this.unread.size;
	}

	/**
	 * The question's words that appear in no note of the vault as it is now (see
	 * `LexicalIndex.absentWords`). The word index answers for the notes it has read. A note created
	 * or edited since (the ten seconds before a change is indexed, an index still being built, an
	 * embedding server that is down) is read here and searched for the words the index lacks: in the
	 * benchmark a note made after indexing held "belts", the model was told no note did, and it
	 * answered that the vault had nothing on them. A word is called absent only when that check
	 * could be made: not before the index has been compared with the vault, and not while more is
	 * unread than is cheap to read. The cost follows the unread notes, not the vault, and is paid
	 * only for a question with a word the index lacks.
	 */
	async absentWords(query: string): Promise<string[]> {
		// Only once the word index exists (a passage search builds it): an unbuilt index would call every word absent.
		if (!this.ready || !this.lexBuilt || !this.compared) return [];
		let absent = this.lex.absentWords(query);
		if (absent.length === 0 || this.unread.size === 0) return absent;
		if (this.unread.size > UNREAD_CHECK_NOTES) return [];
		const seq = this.unreadSeq;
		let chars = 0;
		for (const path of Array.from(this.unread.keys())) {
			// Gone without a word from the vault: there is no text to hold the word; the next sync forgets the note.
			if (!this.vault.exists(path)) continue;
			let text: string;
			try {
				text = await this.vault.read(path);
			} catch {
				return [];
			}
			chars += text.length;
			if (chars > UNREAD_CHECK_CHARS) return [];
			absent = absentFrom(absent, `${noteTitle(path)}\n${text}`);
			if (absent.length === 0) return absent;
		}
		// A note changed while these were being read: what was checked is not the vault as it is now.
		return this.unreadSeq === seq ? absent : [];
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

	/** Resolves when no note is being indexed. For scripts and tests (the benchmark waits for a planted note as a user's next question waits out the pause); the plugin never waits for the index. */
	async idle(): Promise<void> {
		while (this.processing) await this.running;
	}

	private process(): Promise<void> {
		if (this.processing) return Promise.resolve();
		this.running = this.drain();
		return this.running;
	}

	private async drain(): Promise<void> {
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
				const mark = this.unread.get(path);
				const content = await this.vault.read(path);
				const model = this.opts.getModel();
				const chunks = chunkMarkdown(content);
				// A chunk whose heading and text are unchanged keeps its vector; only new or edited
				// chunks go to the embedding model. A note that grows a paragraph at a time (a lecture
				// being transcribed, a daily note being typed) otherwise had every chunk embedded again
				// on each save, which on a laptop is a GPU burst every few seconds for nothing.
				const chunkKey = (c: { crumb: string; text: string }) => `${c.crumb}\n${c.text}`;
				const known = new Map<string, Float32Array>();
				for (const c of this.files.get(path)?.chunks ?? []) known.set(chunkKey(c), c.vec);
				const vecs: (Float32Array | undefined)[] = chunks.map((c) => known.get(chunkKey(c)));
				const missing = chunks.map((_, i) => i).filter((i) => vecs[i] === undefined);
				const inputs = missing.map((i) =>
					embedInput(model, `${noteTitle(path)}${chunks[i].crumb ? ` > ${chunks[i].crumb}` : ""}\n${chunks[i].text}`, "document"),
				);
				for (let i = 0; i < inputs.length; i += batchSize) {
					const vectors = await this.client.embed(model, inputs.slice(i, i + batchSize), signal);
					if (vectors.length && this.dims === 0) this.dims = vectors[0].length;
					vectors.forEach((v, k) => (vecs[missing[i + k]] = normalize(new Float32Array(v))));
				}
				this.setFile(path, { mtime: mtime ?? Date.now(), chunks: chunks.map((c, i) => ({ heading: c.heading, crumb: c.crumb, text: c.text, vec: vecs[i] as Float32Array })) });
				// The index now holds the text that was read, unless the note changed again meanwhile.
				if (this.unread.get(path) === mark && !this.queue.has(path)) this.unread.delete(path);
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
		return { mtime: file.mtime, fmt: EMBED_FORMAT, chunks: file.chunks.map((c) => ({ heading: c.heading, ...(c.crumb !== c.heading ? { crumb: c.crumb } : {}), text: c.text, vec: encodeVec(c.vec) })) };
	}

	/** Saves what changed. Calls queue up: a second flush starting while one is still writing could have its newer shard overwritten by the first one's older copy. */
	flush(): Promise<void> {
		this.flushing = this.flushing.then(() => this.doFlush());
		return this.flushing;
	}

	private async doFlush(): Promise<void> {
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
				// The manifest almost never changes; not rewriting it leaves no moment at which a crash can cut it short.
				const key = `${this.model}|${this.dims}|${SHARDS}`;
				if (key !== this.manifestKey) {
					await this.store.saveManifest!({ version: 2, model: this.model, dims: this.dims, shards: SHARDS });
					this.manifestKey = key;
				}
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
