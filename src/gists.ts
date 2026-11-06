import type { OllamaClient } from "./ollama";
import { OllamaError } from "./ollama";
import type { VaultAccess } from "./types";

/**
 * One-sentence gists of every note, written by the chat model and cached by mtime. The
 * outline in the system prompt uses them so the model knows what each note is *about*
 * without any of them being in context. Persistence and Obsidian wiring are injected.
 */

export interface GistData {
	version: 1;
	model: string;
	files: Record<string, { mtime: number; gist: string }>;
}

export interface GistStore {
	load(): Promise<GistData | null>;
	save(data: GistData): Promise<void>;
}

export interface GistStatus {
	enabled: boolean;
	building: boolean;
	done: number;
	total: number;
	pending: number;
	lastError?: string;
}

export interface GistOptions {
	getModel: () => string;
	isEnabled: () => boolean;
	shouldIndex: (path: string) => boolean;
	/** True while the user is chatting; generation pauses so it does not compete for the GPU. */
	isBusy?: () => boolean;
	onStatus?: (status: GistStatus) => void;
	/** Characters of a note sent to the model (the head of the note). */
	maxChars?: number;
	keepAlive?: string;
	sleep?: (ms: number) => Promise<void>;
}

export const MAX_GIST_CHARS = 240;
const EMPTY = (model: string): GistData => ({ version: 1, model, files: {} });

export function gistPrompt(path: string, content: string, maxChars: number): string {
	const head = content.length > maxChars ? content.slice(0, maxChars) + "\n[…]" : content;
	return [
		`Note path: ${path}`,
		"",
		head,
		"",
		"In one sentence of at most 200 characters, say what this note is about and what it contains (its main topics, decisions or items). Plain text only: no preamble, no quotes, no markdown.",
	].join("\n");
}

/** Normalises a model reply into a single compact line. */
export function cleanGist(text: string): string {
	let t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
	t = t.replace(/^(gist|summary)\s*:\s*/i, "").replace(/^["'“]+|["'”]+$/g, "");
	t = t.replace(/\s+/g, " ").trim();
	if (t.length > MAX_GIST_CHARS) t = t.slice(0, MAX_GIST_CHARS - 1).replace(/\s+\S*$/, "") + "…";
	return t;
}

export class GistCache {
	private data: GistData;
	private queue = new Set<string>();
	private processing = false;
	private lastError: string | undefined;
	private dirty = false;
	private saveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
	private abort: AbortController | null = null;
	private think: boolean | undefined = false;

	constructor(
		private client: OllamaClient,
		private vault: VaultAccess,
		private store: GistStore,
		private opts: GistOptions,
	) {
		this.data = EMPTY(opts.getModel());
	}

	async load(): Promise<void> {
		try {
			const loaded = await this.store.load();
			if (loaded && loaded.version === 1) this.data = loaded;
		} catch (err) {
			this.lastError = `Could not load gists: ${(err as Error).message}`;
		}
		this.emit();
	}

	status(): GistStatus {
		const total = this.vault.listNotes().filter((n) => this.opts.shouldIndex(n.path)).length;
		return {
			enabled: this.opts.isEnabled(),
			building: this.processing,
			done: Object.keys(this.data.files).length,
			total,
			pending: this.queue.size,
			lastError: this.lastError,
		};
	}

	/** The cached gist for a note, if it is current. */
	get(path: string): string | undefined {
		return this.data.files[path]?.gist;
	}

	get count(): number {
		return Object.keys(this.data.files).length;
	}

	/** Queue every note whose mtime changed or that has no gist yet. */
	async syncAll(force = false): Promise<void> {
		if (!this.opts.isEnabled()) return;
		if (force) {
			this.data = EMPTY(this.opts.getModel());
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
		this.emit();
		await this.process();
	}

	enqueue(path: string): void {
		if (!this.opts.isEnabled() || !this.opts.shouldIndex(path)) return;
		this.queue.add(path);
		void this.process();
	}

	remove(path: string): void {
		if (this.data.files[path]) {
			delete this.data.files[path];
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

	cancel(): void {
		this.abort?.abort();
	}

	private async process(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		this.abort = new AbortController();
		const signal = this.abort.signal;
		const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => globalThis.setTimeout(r, ms)));
		try {
			while (this.queue.size > 0 && !signal.aborted) {
				if (this.opts.isBusy?.()) {
					await sleep(2000);
					continue;
				}
				const path = this.queue.values().next().value as string;
				this.queue.delete(path);
				if (!this.vault.exists(path)) {
					this.remove(path);
					continue;
				}
				const note = this.vault.listNotes().find((n) => n.path === path);
				const content = await this.vault.read(path);
				const gist = await this.generate(path, content, signal);
				this.data.files[path] = { mtime: note?.mtime ?? Date.now(), gist };
				this.data.model = this.opts.getModel();
				this.dirty = true;
				this.lastError = undefined;
				this.scheduleSave();
				this.emit();
			}
		} catch (err) {
			if (!signal.aborted) this.lastError = (err as Error).message;
		} finally {
			this.processing = false;
			this.abort = null;
			this.emit();
			await this.flush();
		}
	}

	private async generate(path: string, content: string, signal: AbortSignal): Promise<string> {
		const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
		if (body.length < 80) return cleanGist(body) || "(empty note)";
		const request = (think: boolean | undefined) =>
			this.client.chat({
				model: this.opts.getModel(),
				messages: [
					{ role: "system", content: "You write one-sentence gists of a user's notes. Reply with the sentence only." },
					{ role: "user", content: gistPrompt(path, body, this.opts.maxChars ?? 6000) },
				],
				think,
				options: { num_ctx: 8192, temperature: 0 },
				keep_alive: this.opts.keepAlive ?? "10m",
				signal,
			});
		let res;
		try {
			res = await request(this.think);
		} catch (err) {
			if (this.think !== undefined && err instanceof OllamaError && /think/i.test(err.message)) {
				this.think = undefined;
				res = await request(undefined);
			} else throw err;
		}
		return cleanGist(res.message.content) || "(no gist)";
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
			this.lastError = `Could not save gists: ${(err as Error).message}`;
			this.emit();
		}
	}

	private emit(): void {
		this.opts.onStatus?.(this.status());
	}
}
