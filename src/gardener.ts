import { cosine } from "./index";
import { extractSection } from "./tools";
import type { VaultAccess } from "./types";

/**
 * The vault gardener: a deterministic pass over the whole vault that finds the things a
 * person never gets round to — broken links, orphan notes, names of notes mentioned without
 * a link, stub notes, daily-note inboxes that filled up, duplicate notes — and reports them in
 * the chat with a button per section. The report itself writes nothing to the vault: a checklist
 * note would put dozens of open tasks into every task query over the vault.
 *
 * What can be fixed mechanically is fixed mechanically (`planLinkRepairs`, `planMentionLinks`,
 * `planCopyRemoval`): the plugin works out the exact edits and shows each as a diff, with no
 * model involved, so repointing forty links takes a second instead of ten minutes of a local
 * model reading notes it does not need to read. The model is only asked where judgment is
 * needed: which of two similar notes to merge, and where an orphan belongs.
 */

export interface GardenOptions {
	/** Folder of daily notes ("" for none known); daily notes are exempt from orphan/stub checks. */
	dailyFolder?: string;
	/** Heading of the inbox section inside daily notes. */
	inboxHeading?: string;
	/** Paths to leave out entirely (templates, the conventions note). */
	exclude?: (path: string) => boolean;
	/** Unit vectors per note from the semantic index, for near-duplicate detection. */
	noteVectors?: Map<string, Float32Array>;
	now?: Date;
	/** Cosine similarity at or above which two notes are compared line by line as possible duplicates. */
	duplicateThreshold?: number;
}

export interface BrokenLink {
	path: string;
	target: string;
	/** The one existing note or file with the name the link asks for: the link's target was moved. */
	suggestion?: string;
}

export interface DuplicatePair {
	/** The note to keep (for identical copies: the one with more links to it). */
	a: string;
	b: string;
	/** Share of `b`'s lines that `a` also has, 0–1; 1 for identical copies. */
	score: number;
	/** Same text once frontmatter, blank lines and the folders inside wikilinks are set aside. */
	identical: boolean;
}

export interface GardenReport {
	generated: string;
	notes: number;
	broken: BrokenLink[];
	orphans: string[];
	mentions: { path: string; target: string; count: number }[];
	stubs: { path: string; chars: number }[];
	inboxes: { path: string; lines: number }[];
	duplicates: DuplicatePair[];
}

const CAP = { broken: 60, orphans: 40, mentions: 50, stubs: 30, inboxes: 40, duplicates: 20 };

/** The checklist note earlier versions wrote. Never written any more; left out of the analysis and offered for deletion while it exists. */
export const LEGACY_SUGGESTIONS_NOTE = "Vault Suggestions.md";

/** Findings shown per section in the chat; a button acts on the ones shown, so nothing is changed that was not listed. */
export const CHAT_CAP = 15;

/** Two notes the index calls similar are reported only when they share at least this share of their lines. */
const MIN_LINE_OVERLAP = 0.5;

function basenameOf(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

const noMd = (path: string) => path.replace(/\.md$/i, "");

function stripFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `content` with everything that is not running prose blanked out by spaces of the same length
 * (frontmatter, code, links, URLs, headings, table rows, comments), so an offset found in the
 * result is the offset in the note. A name is only ever linked where this leaves it standing.
 */
export function maskProse(content: string): string {
	const blank = (s: string) => s.replace(/[^\n]/g, " ");
	return content
		.replace(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/, blank)
		.replace(/```[\s\S]*?```/g, blank)
		.replace(/~~~[\s\S]*?~~~/g, blank)
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/%%[\s\S]*?%%/g, blank)
		.replace(/`[^`\n]*`/g, blank)
		.replace(/!?\[\[[^\]\n]*\]\]/g, blank)
		.replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, blank)
		.replace(/https?:\/\/\S+/g, blank)
		.replace(/^#{1,6}\s.*$/gm, blank)
		.replace(/^\s*\|.*$/gm, blank);
}

function isWordChar(ch: string): boolean {
	return /[\p{L}\p{N}_]/u.test(ch);
}

/** Offset of the first whole-word occurrence of `needle` in `hay` at or after `from`, or -1. */
function indexOfWord(hay: string, needle: string, from = 0): number {
	for (;;) {
		const at = hay.indexOf(needle, from);
		if (at < 0) return -1;
		const before = at === 0 ? "" : hay[at - 1];
		const after = at + needle.length >= hay.length ? "" : hay[at + needle.length];
		if ((!before || !isWordChar(before)) && (!after || !isWordChar(after))) return at;
		from = at + needle.length;
	}
}

/** Whole-word occurrences of `needle` in `hay` (the caller lower-cases both for a case-insensitive count). */
export function countWordOccurrences(hay: string, needle: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const at = indexOfWord(hay, needle, from);
		if (at < 0) return count;
		count++;
		from = at + needle.length;
	}
}

/**
 * Whether a note's name is distinctive enough to look for in other notes' prose, and how. Several
 * words are ("Chess Robot"); a single word only when it could not be an ordinary one (GenKIC,
 * HighFold2): a note called Classes or Properties is "mentioned" by every note that uses the word.
 * A name with a capital in it is matched as written, because that is how a name is written when it
 * is meant: "Machine Learning" the course, not every "machine learning" in a lecture.
 */
export function mentionName(basename: string): { name: string; exact: boolean } | null {
	const name = basename.trim();
	if (name.length < 6 || /^\d{4}-\d{2}-\d{2}/.test(name)) return null;
	const exact = /\p{Lu}/u.test(name);
	if (/[\s_-]/.test(name)) return { name, exact };
	// One word: only with a digit or a capital inside it (not one written all in capitals).
	const distinctive = /\d/.test(name) || (/\p{Lu}/u.test(name.slice(1)) && /\p{Ll}/u.test(name));
	return distinctive ? { name, exact: true } : null;
}

/** Offset and text of the first mention of `m` in `content`'s prose, or null. */
function findMention(content: string, m: { name: string; exact: boolean }): { at: number; text: string } | null {
	const masked = maskProse(content);
	const at = m.exact ? indexOfWord(masked, m.name) : indexOfWord(masked.toLowerCase(), m.name.toLowerCase());
	return at < 0 ? null : { at, text: content.slice(at, at + m.name.length) };
}

function countMentions(masked: string, maskedLower: string, m: { name: string; exact: boolean }): number {
	return m.exact ? countWordOccurrences(masked, m.name) : countWordOccurrences(maskedLower, m.name.toLowerCase());
}

/** The note's text for comparing two notes: no frontmatter, no blank lines, wikilinks reduced to the name they end in. */
function comparable(content: string): string {
	return stripFrontmatter(content)
		.replace(/\[\[([^\]|#\n]*\/)?([^\]|#\n]+)([^\]\n]*)\]\]/g, "[[$2$3]]")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.join("\n");
}

/** Distinct lines of substance a note consists of (quoted and callout lines left out: slide text and templates repeat across notes). */
function substantialLines(content: string): Set<string> {
	const out = new Set<string>();
	for (const l of comparable(content).split("\n")) {
		if (l.length >= 20 && !l.startsWith(">")) out.add(l.toLowerCase());
	}
	return out;
}

export async function gardenVault(vault: VaultAccess, opts: GardenOptions = {}): Promise<GardenReport> {
	const daily = (opts.dailyFolder ?? "").replace(/^\/+|\/+$/g, "");
	const isDaily = (path: string) => (daily ? path.startsWith(daily + "/") : /^\d{4}-\d{2}-\d{2}$/.test(basenameOf(path)));
	const notes = vault.listNotes().filter((n) => !(opts.exclude?.(n.path) ?? false) && n.path !== LEGACY_SUGGESTIONS_NOTE);
	const texts = new Map<string, string>();
	for (const n of notes) texts.set(n.path, await vault.read(n.path));
	const paths = new Set(notes.map((n) => n.path));

	const report: GardenReport = {
		generated: (opts.now ?? new Date()).toISOString().slice(0, 10),
		notes: notes.length,
		broken: [],
		orphans: [],
		mentions: [],
		stubs: [],
		inboxes: [],
		duplicates: [],
	};

	// Every file name in the vault, to tell a link whose target moved from one whose target is gone.
	const byName = new Map<string, string[]>();
	const addName = (name: string, path: string) => byName.set(name, [...(byName.get(name) ?? []), path]);
	for (const n of vault.listNotes()) addName(n.basename.toLowerCase(), n.path);
	for (const f of vault.listAttachments()) addName(`${f.basename}.${f.extension}`.toLowerCase(), f.path);

	// Broken links and orphans from the metadata.
	const linked = new Map<string, Set<string>>();
	for (const n of notes) {
		const meta = vault.getMetadata(n.path);
		const seen = new Set<string>();
		const resolvedLinks = new Set<string>();
		linked.set(n.path, resolvedLinks);
		for (const raw of meta.links) {
			const target = raw.split("#")[0].split("|")[0].trim();
			if (!target || seen.has(target)) continue;
			seen.add(target);
			const resolved = vault.resolve(target) ?? vault.resolveFile(target);
			// A link that names a folder is only resolved by a file in that folder: [[Old/Note]] is
			// broken once the note lives in New/, even though a note of that name still exists.
			const wanted = noMd(target).toLowerCase();
			if (resolved && (!target.includes("/") || noMd(resolved).toLowerCase().endsWith(wanted) || resolved.toLowerCase().endsWith(wanted))) {
				resolvedLinks.add(resolved);
				continue;
			}
			const candidates = byName.get(noMd(target.split("/").pop() ?? target).toLowerCase()) ?? byName.get((target.split("/").pop() ?? target).toLowerCase()) ?? [];
			report.broken.push(candidates.length === 1 ? { path: n.path, target, suggestion: candidates[0] } : { path: n.path, target });
		}
		if (!isDaily(n.path) && meta.links.length === 0 && meta.backlinks.filter((b) => paths.has(b)).length === 0) report.orphans.push(n.path);
	}
	// The ones that can be repaired first, so they are the ones shown.
	report.broken.sort((x, y) => Number(!x.suggestion) - Number(!y.suggestion));

	// Unlinked mentions: another note's name written out in prose without a wikilink. Not counted:
	// a name two notes share (which one is meant?), a note already linked from this one, and the
	// note a folder is named after (every lecture in Machine Learning/ says "machine learning").
	const nameCount = new Map<string, number>();
	for (const n of notes) nameCount.set(n.basename.toLowerCase(), (nameCount.get(n.basename.toLowerCase()) ?? 0) + 1);
	const names = notes
		.map((n) => ({ path: n.path, m: mentionName(basenameOf(n.path)) }))
		.filter((x): x is { path: string; m: { name: string; exact: boolean } } => x.m !== null && nameCount.get(x.m.name.toLowerCase()) === 1);
	for (const n of notes) {
		const masked = maskProse(texts.get(n.path) ?? "");
		if (!masked.trim()) continue;
		const maskedLower = masked.toLowerCase();
		for (const other of names) {
			if (other.path === n.path || linked.get(n.path)?.has(other.path)) continue;
			if (n.path.toLowerCase().startsWith(noMd(other.path).toLowerCase() + "/")) continue;
			const count = countMentions(masked, maskedLower, other.m);
			if (count > 0) report.mentions.push({ path: n.path, target: other.path, count });
		}
	}
	report.mentions.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

	// Stubs: notes with almost no body. A note with a code block or an embed is never one: a note
	// that is a single query (a task list, a dataview table) or one embedded file is complete as it is.
	for (const n of notes) {
		if (isDaily(n.path)) continue;
		if (/^(```|~~~)|!\[\[/m.test(texts.get(n.path) ?? "")) continue;
		const body = stripFrontmatter(texts.get(n.path) ?? "")
			.replace(/^#{1,6}\s.*$/gm, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (body.length < 80) report.stubs.push({ path: n.path, chars: body.length });
	}

	// Daily inboxes that filled up.
	const heading = (opts.inboxHeading ?? "Capture").replace(/^#+\s*/, "").trim();
	for (const n of notes) {
		if (!isDaily(n.path)) continue;
		const section = extractSection(texts.get(n.path) ?? "", heading);
		if (!section) continue;
		const lines = section.text.split("\n").slice(1).filter((l) => l.trim()).length;
		if (lines >= 3) report.inboxes.push({ path: n.path, lines });
	}
	report.inboxes.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));

	// Identical copies: the same text in two places (a folder copied, a sync conflict). Needs no index.
	const folderSize = new Map<string, number>();
	for (const n of notes) folderSize.set(n.folder, (folderSize.get(n.folder) ?? 0) + 1);
	const groups = new Map<string, string[]>();
	for (const n of notes) {
		const text = comparable(texts.get(n.path) ?? "");
		if (text.length < 80) continue;
		groups.set(text, [...(groups.get(text) ?? []), n.path]);
	}
	const copies = new Set<string>();
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		// Keep the copy the vault points at: most links to it from outside the group, then the
		// fuller folder, then the shorter (un-suffixed) path.
		const rank = (p: string) => vault.getMetadata(p).backlinks.filter((b) => !group.includes(b)).length;
		const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
		const ordered = group
			.map((p) => ({ p, links: rank(p), folder: folderSize.get(folderOf(p)) ?? 0 }))
			.sort((x, y) => y.links - x.links || y.folder - x.folder || x.p.length - y.p.length || x.p.localeCompare(y.p));
		for (const other of ordered.slice(1)) {
			report.duplicates.push({ a: ordered[0].p, b: other.p, score: 1, identical: true });
			copies.add(other.p);
		}
	}

	// Near-duplicates: candidates from the note vectors, kept only when the two notes really share
	// most of their lines. The vectors alone call every lecture built on the same template and slide
	// deck "100% similar"; what the user can act on is text that exists twice.
	if (opts.noteVectors) {
		const threshold = opts.duplicateThreshold ?? 0.9;
		const candidates = notes.filter((n) => !isDaily(n.path) && !copies.has(n.path) && (texts.get(n.path)?.length ?? 0) >= 200 && opts.noteVectors!.has(n.path));
		const lineSets = new Map<string, Set<string>>();
		const linesOf = (p: string) => {
			let s = lineSets.get(p);
			if (!s) lineSets.set(p, (s = substantialLines(texts.get(p) ?? "")));
			return s;
		};
		const similar: DuplicatePair[] = [];
		for (let i = 0; i < candidates.length; i++) {
			for (let j = i + 1; j < candidates.length; j++) {
				if (cosine(opts.noteVectors.get(candidates[i].path)!, opts.noteVectors.get(candidates[j].path)!) < threshold) continue;
				const [x, y] = [linesOf(candidates[i].path), linesOf(candidates[j].path)];
				const [small, large] = x.size <= y.size ? [x, y] : [y, x];
				if (small.size < 3) continue;
				let shared = 0;
				for (const l of small) if (large.has(l)) shared++;
				const score = shared / small.size;
				if (score < MIN_LINE_OVERLAP) continue;
				// `a` is the fuller note, `b` the one mostly contained in it.
				const [a, b] = x.size >= y.size ? [candidates[i].path, candidates[j].path] : [candidates[j].path, candidates[i].path];
				similar.push({ a, b, score, identical: false });
			}
		}
		similar.sort((p, q) => q.score - p.score);
		report.duplicates.push(...similar);
	}

	report.broken = report.broken.slice(0, CAP.broken);
	report.orphans = report.orphans.sort().slice(0, CAP.orphans);
	report.mentions = report.mentions.slice(0, CAP.mentions);
	report.stubs = report.stubs.sort((a, b) => a.chars - b.chars).slice(0, CAP.stubs);
	report.inboxes = report.inboxes.slice(0, CAP.inboxes);
	report.duplicates = report.duplicates.slice(0, CAP.duplicates);
	return report;
}

const link = (path: string) => `[[${noMd(path)}]]`;

export type GardenSection = "broken" | "inboxes" | "mentions" | "duplicates" | "orphans" | "stubs";

function sectionLines(r: GardenReport, section: GardenSection): string[] {
	switch (section) {
		case "broken":
			return r.broken.map((b) => `${link(b.path)} links to \`[[${b.target}]]\`${b.suggestion ? ` — it is now ${link(b.suggestion)}` : ""}`);
		case "inboxes":
			return r.inboxes.map((i) => `${link(i.path)} — ${i.lines} lines`);
		case "mentions":
			return r.mentions.map((m) => `${link(m.path)} mentions ${link(m.target)} ${m.count === 1 ? "once" : `${m.count} times`} without linking`);
		case "duplicates":
			return r.duplicates.map((d) =>
				d.identical ? `${link(d.b)} is a copy of ${link(d.a)} (identical text)` : `${link(d.b)} shares ${Math.round(d.score * 100)}% of its lines with ${link(d.a)}`,
			);
		case "orphans":
			return r.orphans.map((o) => link(o));
		case "stubs":
			return r.stubs.map((s) => `${link(s.path)} — ${s.chars} characters`);
	}
}

const SECTIONS: { id: GardenSection; title: string; about: string }[] = [
	{ id: "broken", title: "Broken links", about: "Links to notes or files that do not exist. Where the target only moved, I can repoint the link; the rest need you (recreate the file, or tell me to remove the link)." },
	{ id: "inboxes", title: "Daily inboxes with content", about: "Capture sections that grew past a line or two." },
	{ id: "mentions", title: "Unlinked mentions", about: "A note's name written in another note that does not link to it." },
	{ id: "duplicates", title: "Duplicates", about: "The same text in two notes." },
	{ id: "orphans", title: "Orphans", about: "Notes with no links in or out." },
	{ id: "stubs", title: "Stubs", about: "Notes with almost no content. Fill them in, merge them or delete them; tell me which." },
];

/**
 * The report as a chat message: a plain bullet list per section (never `- [ ]`, so nothing in it
 * can turn into a task), at most CHAT_CAP findings each.
 */
export function renderGardenChat(r: GardenReport, opts: { hasIndex?: boolean } = {}): string {
	const out: string[] = [];
	const total = r.broken.length + r.orphans.length + r.mentions.length + r.stubs.length + r.inboxes.length + r.duplicates.length;
	if (total === 0) {
		out.push(`**Vault suggestions** — checked ${r.notes} notes and found nothing to suggest: no broken links, orphans, unlinked mentions, stubs, full inboxes or duplicates.`);
	} else {
		out.push(`**Vault suggestions** — checked ${r.notes} notes. Nothing has been changed or written. The buttons below act on what is listed here (each change is shown as a diff first), or tell me what to do with any of it.`);
	}
	for (const s of SECTIONS) {
		const lines = sectionLines(r, s.id);
		if (lines.length === 0) continue;
		out.push("", `**${s.title} (${lines.length})** — ${s.about}`, "");
		for (const l of lines.slice(0, CHAT_CAP)) out.push(`- ${l}`);
		if (lines.length > CHAT_CAP) out.push(`- …and ${lines.length - CHAT_CAP} more; run /garden again once these are dealt with.`);
	}
	if (opts.hasIndex === false) {
		out.push("", "Only exact copies are detected without semantic search; turn it on (settings → Search) to also find notes that mostly repeat another.");
	}
	return out.join("\n");
}

export type GardenAction = "repair-links" | "inboxes" | "link-mentions" | "remove-copies" | "review-similar" | "orphans";

export interface GardenFix {
	action: GardenAction;
	/** Button text. */
	label: string;
	/**
	 * What to send to the agent, for the two actions that need judgment. Absent for the mechanical
	 * ones, which the plugin plans and applies itself, and for the inboxes, which run "Process my
	 * daily notes".
	 */
	prompt?: string;
}

const NO_TASKS = "Never add checkboxes, tasks or TODO items to any note, and do not create a note to track this work; report in the chat.";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The findings of a section that are listed in the chat, which is what its button acts on. */
function shown<T>(all: T[], keep: (x: T) => boolean): T[] {
	return all.slice(0, CHAT_CAP).filter(keep);
}

/** One action per section that has something to act on. Stubs have none: only the user knows what belongs there. */
export function gardenFixes(r: GardenReport): GardenFix[] {
	const fixes: GardenFix[] = [];
	const moved = shown(r.broken, (b) => b.suggestion !== undefined);
	if (moved.length) fixes.push({ action: "repair-links", label: `Repoint ${plural(moved.length, "moved link")}` });
	if (r.inboxes.length) fixes.push({ action: "inboxes", label: "Process daily inboxes" });
	const mentions = shown(r.mentions, () => true);
	if (mentions.length) fixes.push({ action: "link-mentions", label: `Link ${plural(mentions.length, "mention")}` });
	const copies = shown(r.duplicates, (d) => d.identical);
	if (copies.length) fixes.push({ action: "remove-copies", label: `Remove ${plural(copies.length, "identical copy", "identical copies")}` });
	const similar = shown(r.duplicates, (d) => !d.identical);
	if (similar.length) {
		fixes.push({
			action: "review-similar",
			label: "Review similar notes",
			prompt: [
				"These notes mostly repeat another note:",
				...similar.map((d) => `- ${link(d.b)} shares ${Math.round(d.score * 100)}% of its lines with ${link(d.a)}`),
				"",
				"For each pair, read both notes (read_note, each note once) and tell me in one or two lines what the first has that the second lacks, and your recommendation: merge the first into the second, or keep both and link them. Change nothing yet; I will tell you which recommendations to carry out.",
				NO_TASKS,
			].join("\n"),
		});
	}
	if (r.orphans.length) {
		fixes.push({
			action: "orphans",
			label: "Suggest links for orphans",
			prompt: [
				"These notes have no links in or out:",
				...r.orphans.slice(0, CHAT_CAP).map((o) => `- ${link(o)}`),
				"",
				"For each, find the one existing note that should link to it: a hub or parent note from the vault outline, or search_notes with the orphan's title. Do not read the orphans themselves unless the title says nothing. Tell me your proposal as a list, one line per orphan: `[[orphan]] ← [[note that should link to it]]` and a few words why, or `no good home` when nothing fits. Change nothing yet; I will tell you which links to add.",
				NO_TASKS,
			].join("\n"),
		});
	}
	return fixes;
}

/** One file's change, worked out without a model: shown as a diff, applied and recorded for undo like an agent edit. */
export interface PlannedChange {
	tool: "edit_note" | "delete_file";
	path: string;
	before: string;
	/** "" for a deletion (the note goes to the trash). */
	after: string;
	summary: string;
}

export interface GardenPlan {
	changes: PlannedChange[];
	/** Findings that no longer apply (the note changed since the report), one line each. */
	skipped: string[];
}

/** Collects edits per note, so a note with five links to repoint is one diff, not five. */
class Edits {
	private current = new Map<string, { before: string; text: string; what: string[] }>();
	constructor(private vault: VaultAccess) {}

	async read(path: string): Promise<string | null> {
		const held = this.current.get(path);
		if (held) return held.text;
		if (!this.vault.exists(path)) return null;
		const text = await this.vault.read(path);
		this.current.set(path, { before: text, text, what: [] });
		return text;
	}

	write(path: string, text: string, what: string): void {
		const held = this.current.get(path);
		if (!held || held.text === text) return;
		held.text = text;
		held.what.push(what);
	}

	changes(): PlannedChange[] {
		return Array.from(this.current.entries())
			.filter(([, e]) => e.text !== e.before)
			.map(([path, e]) => ({ tool: "edit_note" as const, path, before: e.before, after: e.text, summary: `${path}: ${e.what.join("; ")}` }));
	}
}

/** Rewrites every wikilink or embed whose target is exactly `from` (any alias or heading kept) to point at `to`. */
function repoint(text: string, from: string, to: string): string {
	return text.replace(new RegExp(`(!?\\[\\[)${escapeRegExp(from)}(?:\\.md)?(?=[\\]|#])`, "gi"), (_, open: string) => `${open}${to}`);
}

/** Links whose target moved: the link is rewritten to where the note or file is now. */
export async function planLinkRepairs(vault: VaultAccess, broken: BrokenLink[]): Promise<GardenPlan> {
	const edits = new Edits(vault);
	const skipped: string[] = [];
	for (const b of broken) {
		if (!b.suggestion) continue;
		const text = await edits.read(b.path);
		const target = /\.md$/i.test(b.suggestion) ? noMd(b.suggestion) : b.suggestion;
		const next = text === null || !vault.resolveFile(b.suggestion) ? null : repoint(text, noMd(b.target), target);
		if (next === null || next === text) skipped.push(`${link(b.path)} → \`[[${b.target}]]\`: the link or its new target is no longer there`);
		else edits.write(b.path, next, `[[${b.target}]] → [[${target}]]`);
	}
	return { changes: edits.changes(), skipped };
}

/** The first mention of each note's name becomes a wikilink that keeps the words as written. */
export async function planMentionLinks(vault: VaultAccess, mentions: { path: string; target: string }[]): Promise<GardenPlan> {
	const edits = new Edits(vault);
	const skipped: string[] = [];
	for (const m of mentions) {
		const text = await edits.read(m.path);
		const name = mentionName(basenameOf(m.target));
		const found = text !== null && name && vault.exists(m.target) ? findMention(text, name) : null;
		if (text === null || !found) {
			skipped.push(`${link(m.path)}: no plain mention of ${link(m.target)} left`);
			continue;
		}
		const target = noMd(m.target);
		// [[Note]] when the words are the note's own path, otherwise the path with the words as the alias.
		const wikilink = found.text === target ? `[[${target}]]` : `[[${target}|${found.text}]]`;
		edits.write(m.path, text.slice(0, found.at) + wikilink + text.slice(found.at + found.text.length), `linked "${found.text}" to [[${target}]]`);
	}
	return { changes: edits.changes(), skipped };
}

/**
 * Identical copies: links that name the copy by its path are repointed to the note that stays,
 * then the copy goes to the trash. A pair whose notes have drifted apart since the report is skipped.
 */
export async function planCopyRemoval(vault: VaultAccess, pairs: DuplicatePair[]): Promise<GardenPlan> {
	const edits = new Edits(vault);
	const skipped: string[] = [];
	const deletions: PlannedChange[] = [];
	const removing = new Set(pairs.filter((p) => p.identical).map((p) => p.b));
	for (const p of pairs) {
		if (!p.identical) continue;
		if (!vault.exists(p.a) || !vault.exists(p.b)) {
			skipped.push(`${link(p.b)}: one of the two notes is already gone`);
			continue;
		}
		const copy = await vault.read(p.b);
		if (comparable(copy) !== comparable(await vault.read(p.a))) {
			skipped.push(`${link(p.b)}: no longer identical to ${link(p.a)}`);
			continue;
		}
		for (const source of vault.getMetadata(p.b).backlinks) {
			if (removing.has(source) || source === p.a) continue;
			const text = await edits.read(source);
			if (text !== null) edits.write(source, repoint(text, noMd(p.b), noMd(p.a)), `[[${noMd(p.b)}]] → [[${noMd(p.a)}]]`);
		}
		deletions.push({ tool: "delete_file", path: p.b, before: copy, after: "", summary: `Delete ${p.b} (identical to ${p.a}; moved to the trash)` });
	}
	return { changes: [...edits.changes(), ...deletions], skipped };
}

/** The plan for one of the mechanical actions, from the findings listed in the chat. */
export async function planGardenAction(vault: VaultAccess, action: GardenAction, r: GardenReport): Promise<GardenPlan | null> {
	switch (action) {
		case "repair-links":
			return planLinkRepairs(vault, shown(r.broken, (b) => b.suggestion !== undefined));
		case "link-mentions":
			return planMentionLinks(vault, shown(r.mentions, () => true));
		case "remove-copies":
			return planCopyRemoval(vault, shown(r.duplicates, (d) => d.identical));
		default:
			return null;
	}
}

/** What was done, as the assistant's reply in the chat. */
export function renderPlanResult(applied: PlannedChange[], plan: GardenPlan, stopped: boolean): string {
	const out: string[] = [];
	if (applied.length === 0) out.push(stopped ? "Nothing was changed: you rejected the first change." : "Nothing to change: none of the listed findings still applies.");
	else {
		out.push(`Done, without the model: ${plural(applied.length, "note")} changed. \`/undo-all\` takes all of it back.`, "");
		for (const c of applied) out.push(`- ${c.tool === "delete_file" ? `${link(c.path)} moved to the trash` : `${link(c.path)} — ${c.summary.slice(c.path.length + 2)}`}`);
		if (stopped) out.push("", `Stopped at the change you rejected; ${plural(plan.changes.length - applied.length, "planned change")} not applied.`);
	}
	if (plan.skipped.length) out.push("", "Skipped:", ...plan.skipped.map((s) => `- ${s}`));
	return out.join("\n");
}
