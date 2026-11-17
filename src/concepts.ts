import { maskProse } from "./gardener";
import type { NoteInfo } from "./types";

/**
 * "Suggest concept links for this note": which existing concept or topic notes a note (a lecture,
 * say) talks about, proposed as one diff: the first plain mention of each becomes a wikilink, notes
 * it is close to by meaning but never names go under "## Related concepts", and optionally the
 * concepts are recorded as `parent` or `child` link properties, the shape Branching Table of
 * Contents reads, so the same concept collects lectures from every course under it.
 * Pure: no Obsidian, no model.
 */

export type ConceptProperty = "none" | "parent" | "child";

export interface ConceptSuggestion {
	path: string;
	/** "mentioned": the note names it in its prose; "related": close by meaning only. */
	kind: "mentioned" | "related";
	/** Offset and text of the first plain mention (kind "mentioned"). */
	mention?: { at: number; text: string };
	/** Similarity for "related" ones. */
	score?: number;
}

/** Folders whose notes count as concept notes unless the user says otherwise. */
export const DEFAULT_CONCEPT_FOLDERS = ["Concepts", "Topics"];

/** Whether a note is a concept/topic note: in a concept folder, tagged #concept/#topic, or `type: concept|topic`. */
export function isConceptNote(n: NoteInfo, folders: string[], meta?: { tags?: string[]; frontmatter?: Record<string, unknown> }): boolean {
	const lower = n.path.toLowerCase();
	if (folders.some((f) => {
		const p = f.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
		return p && (lower.startsWith(p + "/") || lower.includes("/" + p + "/"));
	})) return true;
	if (meta?.tags?.some((t) => /^#?(concept|topic)s?$/i.test(t))) return true;
	const type = meta?.frontmatter?.type ?? meta?.frontmatter?.category;
	return typeof type === "string" && /^(concept|topic)s?$/i.test(type.trim());
}

function isWordChar(ch: string | undefined): boolean {
	return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}

/** First whole-word, case-insensitive occurrence of `name` in the masked text, or -1. */
function findWord(maskedLower: string, name: string): number {
	const needle = name.toLowerCase();
	let from = 0;
	for (;;) {
		const at = maskedLower.indexOf(needle, from);
		if (at < 0) return -1;
		if (!isWordChar(maskedLower[at - 1]) && !isWordChar(maskedLower[at + needle.length])) return at;
		from = at + needle.length;
	}
}

/** Names a concept note goes by: its file name and its `aliases`, 4+ characters, no dates. */
export function conceptNames(n: NoteInfo, aliases: unknown): string[] {
	const out = [n.basename];
	if (Array.isArray(aliases)) for (const a of aliases) if (typeof a === "string") out.push(a);
	if (typeof aliases === "string") out.push(...aliases.split(","));
	return Array.from(new Set(out.map((s) => s.trim()))).filter((s) => s.length >= 4 && !/^\d{4}-\d{2}-\d{2}/.test(s));
}

/** Link targets the note already has (lower case, without .md and subpaths; both the full path and the name). */
function existingLinks(content: string): Set<string> {
	const out = new Set<string>();
	for (const m of content.matchAll(/\[\[([^\]|#]+)/g)) {
		const t = m[1].trim().replace(/\.md$/i, "").toLowerCase();
		out.add(t);
		out.add(t.split("/").pop() ?? t);
	}
	for (const m of content.matchAll(/^\s*(?:parent|child|children|up|related)\s*:.*$/gim)) for (const l of m[0].matchAll(/\[\[([^\]|#]+)/g)) out.add(l[1].trim().toLowerCase());
	return out;
}

/**
 * Concept notes the note mentions (longest names first, so "Gradient Descent" wins over "Gradient"),
 * then up to `maxRelated` notes `related` ranks close by meaning that it neither mentions nor links.
 */
export function suggestConcepts(
	current: { path: string; content: string },
	concepts: { note: NoteInfo; names: string[] }[],
	related: { path: string; score: number }[] = [],
	maxRelated = 5,
): ConceptSuggestion[] {
	const masked = maskProse(current.content).toLowerCase();
	const linked = existingLinks(current.content);
	const out: ConceptSuggestion[] = [];
	const taken: [number, number][] = [];
	const candidates = concepts
		.filter((c) => c.note.path !== current.path)
		.flatMap((c) => c.names.map((name) => ({ c, name })))
		.sort((a, b) => b.name.length - a.name.length);
	for (const { c, name } of candidates) {
		const target = c.note.path.replace(/\.md$/i, "").toLowerCase();
		if (out.some((o) => o.path === c.note.path) || linked.has(target) || linked.has(c.note.basename.toLowerCase())) continue;
		let at = findWord(masked, name);
		// A mention inside a longer name already taken ("Descent" in "Gradient Descent") is not one.
		while (at >= 0 && taken.some(([a, b]) => at < b && at + name.length > a)) {
			const next = findWord(masked.slice(at + name.length), name);
			at = next < 0 ? -1 : at + name.length + next;
		}
		if (at < 0) continue;
		taken.push([at, at + name.length]);
		out.push({ path: c.note.path, kind: "mentioned", mention: { at, text: current.content.slice(at, at + name.length) } });
	}
	const conceptPaths = new Set(concepts.map((c) => c.note.path));
	for (const r of [...related].sort((a, b) => b.score - a.score)) {
		if (out.filter((o) => o.kind === "related").length >= maxRelated) break;
		if (r.path === current.path || !conceptPaths.has(r.path) || out.some((o) => o.path === r.path)) continue;
		const target = r.path.replace(/\.md$/i, "").toLowerCase();
		if (linked.has(target) || linked.has(target.split("/").pop() ?? target)) continue;
		out.push({ path: r.path, kind: "related", score: r.score });
	}
	return out;
}

function noMd(p: string): string {
	return p.replace(/\.md$/i, "");
}

/** Wikilink to a note: [[Path]] when the words are its path, else [[Path|words]]. */
function linkFor(path: string, text?: string): string {
	const target = noMd(path);
	return !text || text === target ? `[[${target}]]` : `[[${target}|${text}]]`;
}

/**
 * Sets a frontmatter property to a list of wikilinks, keeping the links it already has (as a YAML
 * block list of quoted links, which Obsidian shows as a link property). Adds a frontmatter block when
 * the note has none.
 */
export function setLinkProperty(content: string, key: string, links: string[]): string {
	const nl = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(/\r?\n/);
	const hasFm = lines[0] === "---" && lines.indexOf("---", 1) > 0;
	const quote = (l: string) => `  - "${l.replace(/"/g, '\\"')}"`;
	if (!hasFm) {
		if (!links.length) return content;
		return ["---", `${key}:`, ...links.map(quote), "---", ...lines].join(nl);
	}
	const end = lines.indexOf("---", 1);
	const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:(.*)$`);
	const at = lines.findIndex((l, i) => i > 0 && i < end && keyRe.test(l));
	const existing: string[] = [];
	let stop = at + 1;
	if (at > 0) {
		const inline = keyRe.exec(lines[at])![1].trim();
		for (const m of inline.matchAll(/\[\[[^\]]+\]\]/g)) existing.push(m[0]);
		while (stop < end && /^\s+(-\s|\S)/.test(lines[stop]) && !/^\S/.test(lines[stop])) {
			for (const m of lines[stop].matchAll(/\[\[[^\]]+\]\]/g)) existing.push(m[0]);
			stop++;
		}
	}
	const target = (l: string) => l.replace(/^\[\[|\]\]$/g, "").replace(/[|#].*$/, "").trim().toLowerCase();
	const merged = [...existing];
	for (const l of links) if (!merged.some((e) => target(e) === target(l))) merged.push(l);
	const block = [`${key}:`, ...merged.map(quote)];
	if (at > 0) lines.splice(at, stop - at, ...block);
	else lines.splice(end, 0, ...block);
	return lines.join(nl);
}

/** Adds links under a "## Related concepts" heading (created at the end when missing), skipping ones already there. */
export function addRelatedSection(content: string, paths: string[], heading = "Related concepts"): string {
	if (!paths.length) return content;
	const nl = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(/\r?\n/);
	const at = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "i").test(l));
	const items = paths.map((p) => `- ${linkFor(p)}`);
	if (at < 0) return `${content.replace(/\s+$/, "")}${nl}${nl}## ${heading}${nl}${nl}${items.join(nl)}${nl}`;
	let end = at + 1;
	while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
	let insert = end;
	while (insert > at + 1 && !lines[insert - 1].trim()) insert--;
	const have = lines.slice(at, end).join("\n").toLowerCase();
	const fresh = items.filter((i) => !have.includes(i.toLowerCase()));
	lines.splice(insert, 0, ...fresh);
	return lines.join(nl);
}

/** The note with the chosen suggestions applied: mentions linked in place, related ones listed, and the property set. */
export function applyConceptLinks(content: string, chosen: ConceptSuggestion[], property: ConceptProperty): string {
	let out = content;
	const mentions = chosen.filter((c) => c.kind === "mentioned" && c.mention).sort((a, b) => b.mention!.at - a.mention!.at);
	for (const c of mentions) {
		const { at, text } = c.mention!;
		if (out.slice(at, at + text.length) !== text) continue;
		out = out.slice(0, at) + linkFor(c.path, text) + out.slice(at + text.length);
	}
	out = addRelatedSection(out, chosen.filter((c) => c.kind === "related").map((c) => c.path));
	if (property !== "none" && chosen.length) out = setLinkProperty(out, property, chosen.map((c) => `[[${noMd(c.path)}]]`));
	return out;
}
