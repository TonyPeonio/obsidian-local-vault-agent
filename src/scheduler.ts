import { carryOnto } from "./undo";
import type { FileInfo, NoteInfo, NoteMetadata, VaultAccess } from "./types";

/**
 * Scheduled jobs: a nightly "Process my daily notes" and a weekly digest note. Obsidian has no
 * background service, so a job runs when Obsidian is open at or after its time (checked on load and
 * every minute). A job never writes: it runs against an `OverlayVault`, which keeps every write in
 * memory, and what it would have written is queued as pending changes. The user reviews them as
 * ordinary diffs the next time they are at the keyboard; a change whose note was edited in the
 * meantime is carried over when it does not overlap the edit and refused when it does.
 * Pure: no Obsidian imports.
 */

export type JobId = "daily" | "digest";

export interface ScheduleSettings {
	/** Run "Process my daily notes" every night. */
	nightlyDaily: boolean;
	/** "HH:MM", local time. */
	nightlyTime: string;
	/** Write a digest note once a week. */
	weeklyDigest: boolean;
	/** 0 = Sunday … 6 = Saturday. */
	digestDay: number;
	digestTime: string;
	/** Folder for digest notes ("" = vault root). */
	digestFolder: string;
}

/** Minutes after midnight for "HH:MM", or null when malformed. */
export function parseTime(hhmm: string): number | null {
	const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(hhmm);
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	return h < 24 && min < 60 ? h * 60 + min : null;
}

/** The most recent moment at or before `now` the job was scheduled for (local time), or null when it is off. */
export function lastScheduled(job: JobId, now: Date, s: ScheduleSettings): Date | null {
	if (job === "daily" ? !s.nightlyDaily : !s.weeklyDigest) return null;
	const minutes = parseTime(job === "daily" ? s.nightlyTime : s.digestTime);
	if (minutes === null) return null;
	const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(minutes / 60), minutes % 60, 0, 0);
	if (job === "daily") {
		if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 1);
		return at;
	}
	const day = ((Math.floor(s.digestDay) % 7) + 7) % 7;
	at.setDate(at.getDate() - ((at.getDay() - day + 7) % 7));
	if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 7);
	return at;
}

/**
 * Jobs whose latest scheduled time has passed since they last ran. A job with no recorded run is
 * not due: turning a job on records "now" as its last run, so it first runs at its next time.
 */
export function dueJobs(now: Date, s: ScheduleSettings, lastRuns: Partial<Record<JobId, number>>): JobId[] {
	const out: JobId[] = [];
	for (const job of ["daily", "digest"] as JobId[]) {
		const at = lastScheduled(job, now, s);
		const last = lastRuns[job];
		if (at && typeof last === "number" && last < at.getTime()) out.push(job);
	}
	return out;
}

/** YYYY-MM-DD in local time. */
export function localDate(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * A vault that reads through to `base` and keeps every write in memory. Creating and editing notes
 * works as usual inside the run (later steps see earlier writes); moving, deleting and attachments
 * are refused, since those cannot wait in a queue as a diff.
 */
export class OverlayVault implements VaultAccess {
	private writes = new Map<string, string>();
	private created = new Set<string>();

	constructor(private base: VaultAccess) {}

	listNotes(): NoteInfo[] {
		const notes = this.base.listNotes().map((n) => (this.writes.has(n.path) ? { ...n, size: this.writes.get(n.path)!.length } : n));
		for (const path of this.created) {
			const name = path.split("/").pop() ?? path;
			notes.push({ path, basename: name.replace(/\.md$/i, ""), folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", mtime: Date.now(), ctime: Date.now(), size: this.writes.get(path)?.length ?? 0 });
		}
		return notes;
	}

	resolve(pathOrName: string): string | null {
		const p = pathOrName.trim().replace(/^\[\[|\]\]$/g, "").replace(/^\/+/, "");
		for (const c of [p, `${p}.md`]) if (this.created.has(c)) return c;
		const name = p.replace(/\.md$/i, "").toLowerCase();
		for (const c of this.created) if ((c.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase() === name) return c;
		return this.base.resolve(pathOrName);
	}

	exists(path: string): boolean {
		return this.created.has(path) || this.base.exists(path);
	}

	async read(path: string): Promise<string> {
		const held = this.writes.get(path);
		return held !== undefined ? held : this.base.read(path);
	}

	async create(path: string, content: string): Promise<void> {
		if (this.exists(path)) throw new Error(`Already exists: ${path}`);
		this.created.add(path);
		this.writes.set(path, content);
	}

	async modify(path: string, content: string): Promise<void> {
		if (!this.exists(path)) throw new Error(`Note not found: ${path}`);
		this.writes.set(path, content);
	}

	listAttachments(): FileInfo[] {
		return this.base.listAttachments();
	}

	resolveFile(path: string): string | null {
		return this.resolve(path) ?? this.base.resolveFile(path);
	}

	async trash(): Promise<void> {
		throw new Error("Deleting is not possible in a scheduled run; only new notes and edits can wait for approval.");
	}

	readBinary(path: string): Promise<ArrayBuffer> {
		return this.base.readBinary(path);
	}

	async createBinary(): Promise<void> {
		throw new Error("Attachments cannot be written in a scheduled run.");
	}

	async rename(): Promise<void> {
		throw new Error("Moving is not possible in a scheduled run; only new notes and edits can wait for approval.");
	}

	getMetadata(path: string): NoteMetadata {
		const held = this.writes.get(path);
		if (held === undefined) return this.base.getMetadata(path);
		const meta = this.created.has(path) ? { tags: [], links: [], backlinks: [], headings: [], frontmatter: {} } : this.base.getMetadata(path);
		return {
			...meta,
			headings: Array.from(held.matchAll(/^(#{1,6}) (.+)$/gm), (m) => `${m[1]} ${m[2]}`),
			links: Array.from(held.matchAll(/\[\[([^\]|#]+)/g), (m) => m[1]),
		};
	}

	getActiveNotePath(): string | null {
		return null;
	}

	getSelection(): string | null {
		return null;
	}

	/** What the run would write, one change per note, compared with the vault as it is now. */
	async changes(): Promise<{ path: string; tool: "create_note" | "edit_note"; before: string; after: string }[]> {
		const out: { path: string; tool: "create_note" | "edit_note"; before: string; after: string }[] = [];
		for (const [path, after] of this.writes) {
			const created = this.created.has(path);
			const before = created ? "" : await this.base.read(path);
			if (before !== after) out.push({ path, tool: created ? "create_note" : "edit_note", before, after });
		}
		return out;
	}
}

export interface PendingChange {
	id: number;
	job: JobId;
	path: string;
	tool: "create_note" | "edit_note";
	before: string;
	after: string;
	summary: string;
	/** When the job produced it (ms). */
	time: number;
}

export const JOB_NAMES: Record<JobId, string> = { daily: "Nightly: process my daily notes", digest: "Weekly digest" };

/** Changes scheduled jobs produced and the user has not reviewed yet (saved in `pending.json`). */
export class PendingQueue {
	private items: PendingChange[] = [];
	private nextId = 1;
	private listeners = new Set<() => void>();

	get size(): number {
		return this.items.length;
	}

	list(): readonly PendingChange[] {
		return this.items;
	}

	add(job: JobId, changes: { path: string; tool: "create_note" | "edit_note"; before: string; after: string }[], time = Date.now()): PendingChange[] {
		const added: PendingChange[] = [];
		for (const c of changes) {
			// A newer run's change to the same note replaces the unreviewed older one.
			const old = this.items.findIndex((i) => i.path === c.path && i.job === job);
			const before = old >= 0 ? this.items[old].before : c.before;
			if (old >= 0) this.items.splice(old, 1);
			const item: PendingChange = { ...c, before, id: this.nextId++, job, time, summary: `${JOB_NAMES[job]}: ${c.tool === "create_note" ? "create" : "edit"} ${c.path}` };
			this.items.push(item);
			added.push(item);
		}
		if (added.length) this.emit();
		return added;
	}

	remove(id: number): void {
		const n = this.items.length;
		this.items = this.items.filter((i) => i.id !== id);
		if (this.items.length !== n) this.emit();
	}

	load(data: unknown): void {
		if (!Array.isArray(data)) return;
		this.items = data.filter((d): d is PendingChange => {
			const c = d as Partial<PendingChange> | null;
			return !!c && typeof c.id === "number" && typeof c.path === "string" && typeof c.after === "string" && typeof c.before === "string";
		});
		this.nextId = this.items.reduce((m, c) => Math.max(m, c.id), 0) + 1;
		this.emit();
	}

	toJSON(): PendingChange[] {
		return this.items;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const l of this.listeners) l();
	}
}

/**
 * What applying a queued change means for the vault as it is now: the content to write, or why it
 * cannot be applied (the note was created, deleted or edited in an overlapping way since).
 */
export async function planPending(change: PendingChange, vault: VaultAccess): Promise<{ ok: true; before: string; after: string } | { ok: false; reason: string }> {
	if (change.tool === "create_note") {
		if (vault.exists(change.path)) return { ok: false, reason: `${change.path} was created in the meantime.` };
		return { ok: true, before: "", after: change.after };
	}
	if (!vault.exists(change.path)) return { ok: false, reason: `${change.path} no longer exists.` };
	const current = await vault.read(change.path);
	const after = carryOnto(current, change.before, change.after);
	if (after === null) return { ok: false, reason: `${change.path} was edited since the job ran, where the job would change it.` };
	if (after === current) return { ok: false, reason: `${change.path} already has this change.` };
	return { ok: true, before: current, after };
}

/** Notes modified in the `days` before `now`, newest first. */
export function recentNotes(notes: NoteInfo[], now: Date, days = 7): NoteInfo[] {
	const since = now.getTime() - days * 86_400_000;
	return notes.filter((n) => n.mtime >= since && n.mtime <= now.getTime() + 60_000).sort((a, b) => b.mtime - a.mtime);
}

/** The prompt that turns a week's changed notes into a digest (no tools: the notes are in the prompt). */
export function digestPrompt(weekOf: string, notes: { path: string; text: string }[]): string {
	return [
		`Write a short weekly digest of my notes for the week ending ${weekOf}. Below are the notes I created or changed this week.`,
		"Group what happened by theme in a few short sections with '###' headings (projects, courses, ideas, people, …). Under each, 2–5 bullets with the concrete facts, decisions, deadlines and open questions, each bullet ending with the wikilink of the note it came from, e.g. [[Projects/Chess Robot]]. Finish with '### Open threads': things left unfinished or to follow up.",
		"Use only what is in these notes; never invent anything. No preamble, no closing remarks; start with the first '###' heading.",
		"",
		...notes.map((n) => `--- ${n.path.replace(/\.md$/i, "")} ---\n${n.text}`),
	].join("\n");
}

export function digestPath(folder: string, weekOf: string): string {
	const f = folder.replace(/^\/+|\/+$/g, "");
	return `${f ? f + "/" : ""}Digest ${weekOf}.md`;
}

/** The digest note: the model's summary plus a list of every note changed that week. */
export function renderDigest(weekOf: string, summary: string, notes: NoteInfo[]): string {
	const list = notes.map((n) => `- [[${n.path.replace(/\.md$/i, "")}]] (${localDate(new Date(n.mtime))})`);
	return [`# Weekly digest, week ending ${weekOf}`, "", summary.trim(), "", "## Notes changed this week", "", ...list, ""].join("\n");
}
