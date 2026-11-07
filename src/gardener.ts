import { cosine } from "./index";
import { extractSection } from "./tools";
import type { VaultAccess } from "./types";

/**
 * The vault gardener: a deterministic pass over the whole vault that finds the things a
 * person never gets round to — broken links, orphan notes, names of notes mentioned without
 * a link, stub notes, daily-note inboxes that filled up, near-duplicate notes — and writes
 * them up as a checklist note the user (or the agent) can work through. No model is needed,
 * so it runs in a second and is exactly right; near-duplicates use the semantic index when
 * it exists.
 */

export interface GardenOptions {
	/** Folder of daily notes ("" for none known); daily notes are exempt from orphan/stub checks. */
	dailyFolder?: string;
	/** Heading of the inbox section inside daily notes. */
	inboxHeading?: string;
	/** Paths to leave out entirely (templates, the suggestions note itself). */
	exclude?: (path: string) => boolean;
	/** Unit vectors per note from the semantic index, for near-duplicate detection. */
	noteVectors?: Map<string, Float32Array>;
	now?: Date;
	/** Cosine similarity at or above which two notes count as near-duplicates. */
	duplicateThreshold?: number;
}

export interface GardenReport {
	generated: string;
	notes: number;
	broken: { path: string; target: string }[];
	orphans: string[];
	mentions: { path: string; target: string; count: number }[];
	stubs: { path: string; chars: number }[];
	inboxes: { path: string; lines: number }[];
	duplicates: { a: string; b: string; score: number }[];
}

const CAP = { broken: 60, orphans: 40, mentions: 50, stubs: 30, inboxes: 40, duplicates: 20 };

export const SUGGESTIONS_NOTE = "Vault Suggestions.md";

function basenameOf(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

function stripFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** Text with wikilinks, code and headings removed, for mention scanning. */
function proseOf(content: string): string {
	return stripFrontmatter(content)
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/!?\[\[[^\]]*\]\]/g, " ")
		.replace(/^#{1,6}\s.*$/gm, " ")
		.toLowerCase();
}

function isWordChar(ch: string): boolean {
	return /[\p{L}\p{N}_]/u.test(ch);
}

/** Case-insensitive whole-word occurrences of `needle` in `hay` (both lower-case). */
export function countWordOccurrences(hay: string, needle: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const at = hay.indexOf(needle, from);
		if (at < 0) return count;
		const before = at === 0 ? "" : hay[at - 1];
		const after = at + needle.length >= hay.length ? "" : hay[at + needle.length];
		if ((!before || !isWordChar(before)) && (!after || !isWordChar(after))) count++;
		from = at + needle.length;
	}
}

export async function gardenVault(vault: VaultAccess, opts: GardenOptions = {}): Promise<GardenReport> {
	const daily = (opts.dailyFolder ?? "").replace(/^\/+|\/+$/g, "");
	const isDaily = (path: string) => (daily ? path.startsWith(daily + "/") : /^\d{4}-\d{2}-\d{2}$/.test(basenameOf(path)));
	const notes = vault.listNotes().filter((n) => !(opts.exclude?.(n.path) ?? false) && n.path !== SUGGESTIONS_NOTE);
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

	// Broken links and orphans from the metadata.
	for (const n of notes) {
		const meta = vault.getMetadata(n.path);
		const seen = new Set<string>();
		for (const raw of meta.links) {
			const target = raw.split("#")[0].split("|")[0].trim();
			if (!target || seen.has(target)) continue;
			seen.add(target);
			if (vault.resolve(target) || vault.resolveFile(target)) continue;
			report.broken.push({ path: n.path, target });
		}
		if (!isDaily(n.path) && meta.links.length === 0 && meta.backlinks.filter((b) => paths.has(b)).length === 0) report.orphans.push(n.path);
	}

	// Unlinked mentions: another note's name written out in prose without a wikilink.
	const names = notes
		.map((n) => ({ path: n.path, name: basenameOf(n.path).toLowerCase() }))
		.filter((x) => x.name.length >= 6 && !/^\d{4}-\d{2}-\d{2}/.test(x.name));
	for (const n of notes) {
		const prose = proseOf(texts.get(n.path) ?? "");
		if (!prose.trim()) continue;
		for (const other of names) {
			if (other.path === n.path) continue;
			const count = countWordOccurrences(prose, other.name);
			if (count > 0) report.mentions.push({ path: n.path, target: other.path, count });
		}
	}
	report.mentions.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

	// Stubs: notes with almost no body.
	for (const n of notes) {
		if (isDaily(n.path)) continue;
		const body = proseOf(texts.get(n.path) ?? "").replace(/\s+/g, " ").trim();
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

	// Near-duplicates from note vectors (daily notes share a template, so they are skipped).
	if (opts.noteVectors) {
		const threshold = opts.duplicateThreshold ?? 0.9;
		const candidates = notes.filter((n) => !isDaily(n.path) && (texts.get(n.path)?.length ?? 0) >= 200 && opts.noteVectors!.has(n.path));
		for (let i = 0; i < candidates.length; i++) {
			for (let j = i + 1; j < candidates.length; j++) {
				const score = cosine(opts.noteVectors.get(candidates[i].path)!, opts.noteVectors.get(candidates[j].path)!);
				if (score >= threshold) report.duplicates.push({ a: candidates[i].path, b: candidates[j].path, score });
			}
		}
		report.duplicates.sort((a, b) => b.score - a.score);
	}

	report.broken = report.broken.slice(0, CAP.broken);
	report.orphans = report.orphans.sort().slice(0, CAP.orphans);
	report.mentions = report.mentions.slice(0, CAP.mentions);
	report.stubs = report.stubs.sort((a, b) => a.chars - b.chars).slice(0, CAP.stubs);
	report.inboxes = report.inboxes.slice(0, CAP.inboxes);
	report.duplicates = report.duplicates.slice(0, CAP.duplicates);
	return report;
}

const link = (path: string) => `[[${path.replace(/\.md$/i, "")}]]`;

/** The suggestions note: a checklist per finding, with the question to ask the agent to act on each. */
export function renderGardenReport(r: GardenReport, opts: { hasIndex?: boolean } = {}): string {
	const out: string[] = [];
	const total = r.broken.length + r.orphans.length + r.mentions.length + r.stubs.length + r.inboxes.length + r.duplicates.length;
	out.push("# Vault Suggestions", "", `Generated by Local Vault Agent on ${r.generated} from ${r.notes} notes. Run *Suggest vault improvements* again to refresh; tick items as you deal with them, or ask the agent to work through a section (e.g. "Fix the broken links in [[Vault Suggestions]]").`, "");
	if (total === 0) {
		out.push("Nothing to suggest: no broken links, orphans, unlinked mentions, stubs, full inboxes or near-duplicates found.", "");
		return out.join("\n");
	}
	if (r.broken.length) {
		out.push(`## Broken links (${r.broken.length})`, "", "Links to notes that do not exist. Create the note, fix the name, or remove the link.", "");
		for (const b of r.broken) out.push(`- [ ] ${link(b.path)} links to \`[[${b.target}]]\``);
		out.push("");
	}
	if (r.inboxes.length) {
		out.push(`## Daily inboxes with content (${r.inboxes.length})`, "", "Capture sections that grew past a line or two. *Process my daily notes* compiles them into topic notes.", "");
		for (const i of r.inboxes) out.push(`- [ ] ${link(i.path)} — ${i.lines} lines`);
		out.push("");
	}
	if (r.mentions.length) {
		out.push(`## Unlinked mentions (${r.mentions.length})`, "", "A note's name written in another note without a link. Ask the agent: \"Turn the unlinked mentions in [[Vault Suggestions]] into wikilinks\".", "");
		for (const m of r.mentions) out.push(`- [ ] ${link(m.path)} mentions ${link(m.target)} ${m.count === 1 ? "once" : `${m.count} times`} without linking`);
		out.push("");
	}
	if (r.duplicates.length) {
		out.push(`## Possible duplicates (${r.duplicates.length})`, "", "Pairs of notes whose content is nearly the same by meaning. Merge them, or link them if both should stay.", "");
		for (const d of r.duplicates) out.push(`- [ ] ${link(d.a)} ↔ ${link(d.b)} (${Math.round(d.score * 100)}% similar)`);
		out.push("");
	} else if (opts.hasIndex === false) {
		out.push("## Possible duplicates", "", "Turn on semantic search (settings → Search) and let the index build to get near-duplicate detection here.", "");
	}
	if (r.orphans.length) {
		out.push(`## Orphans (${r.orphans.length})`, "", "Notes with no links in or out. Link them from a hub or parent note, or archive them.", "");
		for (const o of r.orphans) out.push(`- [ ] ${link(o)}`);
		out.push("");
	}
	if (r.stubs.length) {
		out.push(`## Stubs (${r.stubs.length})`, "", "Notes with almost no content. Fill them in, merge them, or delete them.", "");
		for (const s of r.stubs) out.push(`- [ ] ${link(s.path)} — ${s.chars} characters`);
		out.push("");
	}
	return out.join("\n");
}
