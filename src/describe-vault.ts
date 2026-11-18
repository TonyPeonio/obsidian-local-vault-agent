import type { NoteInfo, VaultAccess } from "./types";

/**
 * Drafts the conventions note from the vault itself, without a model: which folders hold what,
 * how notes in them are named and sectioned, which properties and tags are in use. The agent
 * reads the conventions note with every message; without one it has to rediscover on every task
 * that daily notes are `Daily/YYYY-MM-DD` with a `Done` section, and a 9B model often does not.
 * Most vaults have no such note, and nobody writes one unprompted, so the plugin offers this draft
 * for the user to correct. Everything here is counted, nothing is guessed: a line is written only
 * when most notes of a folder agree.
 */

export interface DescribeOptions {
	/** Folders excluded in the plugin's settings: listed as never to be read or edited. */
	excluded?: string[];
	/** Today's date for the "drafted on" line (YYYY-MM-DD). */
	today?: string;
	/** The note this draft is for; it is not described. */
	conventionsPath?: string;
	/** At most this many characters (the note is sent with every message). */
	maxChars?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}\b/;
/** A share of a folder's notes that counts as "most". */
const MOST = 0.6;
/** Headings read from at most this many notes of a folder. */
const SAMPLE = 60;

interface FolderFacts {
	path: string;
	notes: NoteInfo[];
	/** Sub-folders that directly hold notes, when the folder is organised as one folder per thing. */
	groups: Map<string, NoteInfo[]>;
}

function share(n: number, of: number): boolean {
	return of > 0 && n / of >= MOST;
}

function top<T>(counts: Map<T, number>, n: number): [T, number][] {
	return Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, n);
}

function count<T>(map: Map<T, number>, key: T): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

/** Evenly spread sample, so a folder of 5,000 daily notes is not judged by its first month. */
function sample<T>(items: T[], n: number): T[] {
	if (items.length <= n) return items;
	const step = items.length / n;
	return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

/** How the notes of a folder are named, when most agree. */
function naming(notes: NoteInfo[]): string {
	const names = notes.map((n) => n.basename);
	if (share(names.filter((x) => DATE.test(x)).length, names.length)) return "named `YYYY-MM-DD`";
	if (share(names.filter((x) => DATE_PREFIX.test(x)).length, names.length)) return "named `YYYY-MM-DD <title>`";
	// A shared lead-in: "Lectures - CSCI 406", "HW1 - CSCI 406" → nothing shared; "Idea 3 - …" → "Idea <n> - <title>".
	const lead = new Map<string, number>();
	for (const x of names) {
		const m = /^([^\d-]{3,}?)\s*\d+\s*-\s/.exec(x);
		if (m) count(lead, m[1].trim());
	}
	const [best] = top(lead, 1);
	if (best && share(best[1], names.length)) return `named \`${best[0]} <n> - <title>\``;
	return "";
}

/** The section headings most notes of a set share, and whether they are sectioned by date. */
function sections(vault: VaultAccess, notes: NoteInfo[]): { common: string[]; dated: boolean; under: string[] } {
	const picked = sample(notes, SAMPLE);
	const h2 = new Map<string, number>();
	const sub = new Map<string, number>();
	let datedNotes = 0;
	for (const n of picked) {
		const heads = vault.getMetadata(n.path).headings.map((h) => /^(#{1,6}) (.+)$/.exec(h)).filter((m): m is RegExpExecArray => m !== null);
		const level2 = heads.filter((m) => m[1].length === 2).map((m) => m[2].trim());
		const dates = level2.filter((t) => DATE_PREFIX.test(t));
		if (dates.length >= 2 && dates.length >= level2.length / 2) {
			datedNotes++;
			for (const t of new Set(heads.filter((m) => m[1].length === 3).map((m) => m[2].trim()))) count(sub, t);
		}
		for (const t of new Set(level2.filter((t) => !DATE_PREFIX.test(t)))) count(h2, t);
	}
	const dated = share(datedNotes, picked.length);
	return {
		common: top(h2, 6)
			.filter(([, c]) => share(c, picked.length))
			.map(([t]) => t),
		dated,
		under: dated
			? top(sub, 4)
					.filter(([, c]) => c >= Math.max(1, datedNotes / 3))
					.map(([t]) => t)
			: [],
	};
}

function describeSet(vault: VaultAccess, notes: NoteInfo[]): string {
	const parts: string[] = [];
	const name = naming(notes);
	if (name) parts.push(name);
	const s = sections(vault, notes);
	if (s.dated) parts.push(`one \`## YYYY-MM-DD\` section per entry${s.under.length ? `, with ${s.under.map((t) => `\`### ${t}\``).join(", ")} under it where present` : ""}`);
	if (s.common.length) parts.push(`sections ${s.common.map((t) => `\`## ${t}\``).join(", ")}`);
	return parts.join("; ");
}

export function describeVault(vault: VaultAccess, opts: DescribeOptions = {}): string {
	const maxChars = opts.maxChars ?? 2200;
	const excluded = (opts.excluded ?? []).map((f) => f.replace(/^\/+|\/+$/g, "")).filter(Boolean);
	// Notes in an excluded folder are described only as "never touch", whether or not the vault lists them.
	const isExcluded = (p: string) => excluded.some((f) => p.toLowerCase() === f.toLowerCase() || p.toLowerCase().startsWith(f.toLowerCase() + "/"));
	const all = vault.listNotes().filter((n) => n.path !== opts.conventionsPath && !isExcluded(n.path));

	// Folders by their first path segment; a folder whose notes sit one level down in several sub-folders is "one folder per thing".
	const folders = new Map<string, FolderFacts>();
	for (const n of all) {
		const segs = n.path.split("/");
		const topName = segs.length > 1 ? segs[0] : "";
		let f = folders.get(topName);
		if (!f) folders.set(topName, (f = { path: topName, notes: [], groups: new Map() }));
		f.notes.push(n);
		if (segs.length > 2) {
			const g = f.groups.get(segs[1]);
			if (g) g.push(n);
			else f.groups.set(segs[1], [n]);
		}
	}

	const lines: string[] = [];
	const ranked = Array.from(folders.values())
		.filter((f) => f.path !== "")
		.sort((a, b) => b.notes.length - a.notes.length);
	for (const f of ranked.slice(0, 12)) {
		const direct = f.notes.filter((n) => n.path.split("/").length === 2);
		const grouped = f.notes.length - direct.length;
		if (f.groups.size >= 3 && grouped > direct.length) {
			// One sub-folder per thing: describe what the sub-folders have in common.
			const kinds = new Map<string, NoteInfo[]>();
			for (const notes of f.groups.values()) {
				for (const n of notes) {
					const kind = n.basename.includes(" - ") ? n.basename.split(" - ")[0].replace(/\d+$/, "<n>").trim() : "";
					if (!kind) continue;
					const list = kinds.get(kind);
					if (list) list.push(n);
					else kinds.set(kind, [n]);
				}
			}
			const shared = Array.from(kinds.entries())
				.filter(([, notes]) => share(new Set(notes.map((n) => n.path.split("/")[1])).size, f.groups.size))
				.slice(0, 3)
				.map(([kind, notes]) => {
					const d = describeSet(vault, notes);
					return `\`${kind} - <name>.md\`${d ? ` (${d})` : ""}`;
				});
			lines.push(`- \`${f.path}/<name>/\` — ${f.groups.size} folders, ${f.notes.length} notes${shared.length ? `; each has ${shared.join(" and ")}` : ""}.`);
		} else {
			const d = describeSet(vault, f.notes);
			lines.push(`- \`${f.path}/\` — ${f.notes.length} note${f.notes.length === 1 ? "" : "s"}${d ? `, ${d}` : ""}.`);
		}
	}
	if (ranked.length > 12) lines.push(`- ${ranked.length - 12} more folders with fewer notes.`);
	for (const f of excluded) lines.push(`- \`${f}/\` — excluded in the plugin's settings: never read, search or edit.`);

	// Properties and tags, from a sample of the whole vault.
	const picked = sample(all, 400);
	const keys = new Map<string, number>();
	const values = new Map<string, Map<string, number>>();
	const tags = new Map<string, number>();
	let withProps = 0;
	for (const n of picked) {
		const meta = vault.getMetadata(n.path);
		const entries = Object.entries(meta.frontmatter ?? {});
		if (entries.length) withProps++;
		for (const [k, v] of entries) {
			count(keys, k);
			if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
				let m = values.get(k);
				if (!m) values.set(k, (m = new Map<string, number>()));
				count(m, String(v));
			}
		}
		for (const t of new Set(meta.tags)) count(tags, t.startsWith("#") ? t : `#${t}`);
	}
	const meta: string[] = [];
	const usedKeys = top(keys, 6).filter(([, c]) => c >= 3);
	if (usedKeys.length) {
		meta.push(
			`- Properties in use: ${usedKeys
				.map(([k]) => {
					const vs = values.get(k);
					// A property with few distinct values is a field with a vocabulary; show it.
					const few = vs && vs.size <= 5 && vs.size > 0 ? ` (${top(vs, 5).map(([v]) => v).join(", ")})` : "";
					return `\`${k}\`${few}`;
				})
				.join(", ")}.`,
		);
	}
	const usedTags = top(tags, 8).filter(([, c]) => c >= 3);
	if (usedTags.length) meta.push(`- Most used tags: ${usedTags.map(([t, c]) => `${t} (${c})`).join(", ")}.`);
	const style: string[] = ["- Refer to notes and people with wikilinks."];
	if (picked.length >= 5) {
		style.push(
			share(picked.length - withProps, picked.length)
				? "- Most notes have no properties block: never add YAML frontmatter to a note that has none."
				: "- Most notes begin with a properties block: keep it unchanged when editing, and give a new note the properties its folder's notes have.",
		);
	}

	const head = `# Vault conventions for the agent\n\nThe part between the two markers was drafted from this vault${opts.today ? ` on ${opts.today}` : ""} by Local Vault Agent, and the command "Draft the conventions note from this vault" rewrites only that part. Correct what is wrong there, and put your own rules below it: this note is read with every message.\n`;
	const tail = `## Style\n${style.join("\n")}\n\n## Never\n- (Add the rules that matter to you here, one per line: what must not be changed, deleted or moved.)\n`;
	const build = () => {
		const counted = [`## Folders\n${lines.join("\n")}`];
		if (meta.length) counted.push(`## Properties and tags\n${meta.join("\n")}`);
		return `${head}\n${DESCRIPTION_START}\n${counted.join("\n\n")}\n${DESCRIPTION_END}\n\n${tail}`;
	};
	let out = build();
	// Sent with every message: when it runs long, the smallest folders go first.
	while (out.length > maxChars && lines.length > 3 + excluded.length) {
		lines.splice(lines.length - 1 - excluded.length, 1);
		out = build();
	}
	return out;
}

export const DESCRIPTION_START = "<!-- local-vault-agent:vault-description:start -->";
export const DESCRIPTION_END = "<!-- local-vault-agent:vault-description:end -->";

/**
 * A conventions note brought up to date with a fresh draft: the counted part between the markers
 * is replaced and everything the user wrote around it stays. A note without the markers (written
 * by hand, or by an earlier version's template) gets the counted part added at its end; no note
 * at all gets the whole draft.
 */
export function refreshDescription(existing: string | null, draft: string): string {
	if (existing === null || !existing.trim()) return draft;
	const block = draft.slice(draft.indexOf(DESCRIPTION_START), draft.indexOf(DESCRIPTION_END) + DESCRIPTION_END.length);
	const a = existing.indexOf(DESCRIPTION_START);
	const b = existing.indexOf(DESCRIPTION_END);
	if (a >= 0 && b > a) return existing.slice(0, a) + block + existing.slice(b + DESCRIPTION_END.length);
	return `${existing.replace(/\s+$/, "")}\n\n${block}\n`;
}
