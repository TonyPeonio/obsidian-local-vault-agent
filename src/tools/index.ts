import type {
	ApprovalRequest,
	OllamaToolSpec,
	ToolContext,
	ToolDefinition,
	VaultAccess,
} from "../types";
import { applyTextEdit } from "../diff";
import { imageEmbeds } from "../embeds";
import { hasFrontmatter } from "../prompts";

/**
 * The tools the model can call. Each tool returns plain text for the model; the
 * agent wraps errors so the model can recover instead of the whole run failing.
 */

export class ToolError extends Error {}

/** Deleted attachments up to this size are kept in memory so the deletion can be undone. */
export const MAX_UNDO_BINARY_BYTES = 100 * 1024 * 1024;

function str(args: Record<string, unknown>, key: string, required = true): string {
	const v = args[key];
	if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
		if (required) throw new ToolError(`Missing required argument "${key}".`);
		return "";
	}
	return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

function int(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
	const v = args[key];
	const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
	const v = args[key];
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v.toLowerCase() === "true";
	return fallback;
}

/**
 * Normalize a model-supplied path: forward slashes, `.md` extension, no leading slash.
 * `configDir` is the vault's configuration folder (`Vault.configDir`), which is off limits.
 */
/** Like normalizeNotePath but keeps whatever extension the path has (attachments). */
export function normalizeFilePath(input: string, configDir?: string): string {
	let p = input.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	p = p.replace(/^!?\[\[|\]\]$/g, "").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
	if (p.split("/").some((seg) => seg === "..")) throw new ToolError("Paths may not contain '..'.");
	if (configDir) {
		const cfg = configDir.replace(/^\/+|\/+$/g, "").toLowerCase();
		if (cfg && p.toLowerCase().startsWith(cfg + "/")) throw new ToolError(`The ${configDir} folder is off limits.`);
	}
	return p;
}

export function normalizeNotePath(input: string, configDir?: string): string {
	let p = input.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	p = p.replace(/^\[\[|\]\]$/g, "");
	if (!/\.md$/i.test(p)) p += ".md";
	// Collapse accidental double slashes and "./".
	p = p.replace(/\/{2,}/g, "/").replace(/^\.\//, "");
	if (p.split("/").some((seg) => seg === "..")) throw new ToolError("Paths may not contain '..'.");
	if (configDir) {
		const cfg = configDir.replace(/^\/+|\/+$/g, "").toLowerCase();
		if (cfg && p.toLowerCase().startsWith(cfg + "/")) throw new ToolError(`The ${configDir} folder is off limits.`);
	}
	return p;
}

/** A model that copied an outline line ("Folder/Note.md — heading › heading #tag") still gets the note. */
export function stripOutlineDecoration(input: string): string {
	return input.replace(/\s+(—|›|\|)\s.*$/, "").replace(/\s+#\S.*$/, "").replace(/\s+\(.*\)$/, "").trim();
}

/** Resolve a note or attachment path, tolerating outline decorations. */
export function resolveAny(vault: VaultAccess, input: string): string | null {
	const direct = vault.resolveFile(input) ?? vault.resolve(input);
	if (direct) return direct;
	const stripped = stripOutlineDecoration(input);
	if (stripped && stripped !== input) return vault.resolveFile(stripped) ?? vault.resolve(stripped);
	return null;
}

function resolveExisting(vault: VaultAccess, input: string): string {
	let resolved = vault.resolve(input);
	if (!resolved) {
		const stripped = stripOutlineDecoration(input);
		if (stripped && stripped !== input) resolved = vault.resolve(stripped);
	}
	if (!resolved) throw new ToolError(`No note found for "${input}". ${missingNoteHint(vault, input)}`);
	return resolved;
}

/** Folders with at most this many notes are listed in full when a path in them misses. */
const MISS_LIST_ALL = 80;
const MISS_NEAREST = 10;

/**
 * What a model should see after guessing a path that does not exist: the notes that *do*
 * exist in that folder (all of them when the folder is small, else the nearest by name), so
 * one miss teaches it the folder instead of inviting the next guess. Without a folder, or
 * with one that has no notes, the folders that exist and any note with a similar name.
 */
export function missingNoteHint(vault: VaultAccess, input: string): string {
	const cleaned = stripOutlineDecoration(input)
		.replace(/\\/g, "/")
		.replace(/^!?\[\[|\]\]$/g, "")
		.replace(/^\/+|\/+$/g, "");
	const slash = cleaned.lastIndexOf("/");
	const folder = slash >= 0 ? cleaned.slice(0, slash) : "";
	const base = cleaned.slice(slash + 1).replace(/\.md$/i, "");
	const notes = vault.listNotes();
	const inFolder = notes
		.filter((n) => n.folder.toLowerCase() === folder.toLowerCase())
		.map((n) => n.basename)
		.sort((a, b) => a.localeCompare(b));
	const label = folder ? `"${folder}/"` : "the vault root";
	if (inFolder.length > 0) {
		if (inFolder.length <= MISS_LIST_ALL) {
			return `${label} has ${inFolder.length} note${inFolder.length === 1 ? "" : "s"}: ${inFolder.map((b) => `${b}.md`).join(", ")}. Use one of these exact paths; do not guess others.`;
		}
		// Too many to list: the names around where the guess would sort.
		let at = inFolder.findIndex((b) => b.localeCompare(base) >= 0);
		if (at < 0) at = inFolder.length;
		const start = Math.max(0, Math.min(at - MISS_NEAREST / 2, inFolder.length - MISS_NEAREST));
		const near = inFolder.slice(start, start + MISS_NEAREST);
		return `${label} has ${inFolder.length} notes; the nearest by name are ${near.map((b) => `${b}.md`).join(", ")}. Call list_notes({folder: ${JSON.stringify(folder)}}) for all of them; do not guess paths.`;
	}
	const folders = Array.from(new Set(notes.map((n) => n.folder).filter(Boolean))).sort((a, b) => a.localeCompare(b));
	const similar = base
		? notes
				.filter((n) => n.basename.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(n.basename.toLowerCase()))
				.slice(0, 5)
				.map((n) => n.path)
		: [];
	const parts: string[] = [];
	parts.push(folder ? `There is no folder ${label} with notes.` : `No note is named "${base}" in the vault root.`);
	if (similar.length) parts.push(`Similar names: ${similar.join(", ")}.`);
	if (folders.length) parts.push(`Folders with notes: ${folders.slice(0, 40).map((f) => `${f}/`).join(", ")}${folders.length > 40 ? ", …" : ""}.`);
	parts.push("Use list_notes or search_notes to find the exact path; do not guess.");
	return parts.join(" ");
}

/** Every folder that holds a note or an attachment, with each of its parent folders. */
function vaultFolders(vault: VaultAccess): string[] {
	const set = new Set<string>();
	const add = (folder: string) => {
		for (let f = folder; f && !set.has(f); f = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "") set.add(f);
	};
	for (const n of vault.listNotes()) add(n.folder);
	for (const f of vault.listAttachments()) add(f.folder);
	return Array.from(set);
}

function editDistance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
		prev = row;
	}
	return prev[b.length];
}

/**
 * For a `folder` argument that matches nothing: null when the folder exists (so "nothing
 * found" is true), otherwise a sentence saying that it does not, with the existing folders
 * closest to it. Without this a mistyped folder reads as "the vault has no such text".
 */
export function missingFolderHint(vault: VaultAccess, input: string): string | null {
	const wanted = input.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const lower = wanted.toLowerCase();
	const folders = vaultFolders(vault);
	if (!lower || folders.some((f) => f.toLowerCase() === lower)) return null;
	const leaf = lower.slice(lower.lastIndexOf("/") + 1);
	const close = folders
		.map((folder) => {
			const name = folder.toLowerCase().slice(folder.lastIndexOf("/") + 1);
			// The same folder name somewhere else, a name that contains the other, or a typo of it.
			let score = Infinity;
			if (name === leaf) score = 0;
			else if (Math.min(name.length, leaf.length) >= 3 && (name.includes(leaf) || leaf.includes(name))) score = 1;
			else {
				const d = editDistance(name, leaf);
				if (d <= Math.max(2, Math.floor(leaf.length / 3)) && d < Math.min(name.length, leaf.length) * 0.6) score = 1 + d;
			}
			return { folder, score };
		})
		.filter((c) => c.score < Infinity)
		.sort((a, b) => a.score - b.score || a.folder.length - b.folder.length || a.folder.localeCompare(b.folder))
		.slice(0, 5)
		.map((c) => `${c.folder}/`);
	if (close.length) return `There is no folder "${wanted}/". Closest folders: ${close.join(", ")}.`;
	const top = folders.filter((f) => !f.includes("/")).sort((a, b) => a.localeCompare(b));
	return `There is no folder "${wanted}/".${top.length ? ` Top-level folders: ${top.slice(0, 15).map((f) => `${f}/`).join(", ")}${top.length > 15 ? ", …" : ""}.` : " The vault has no folders."}`;
}

function hashText(text: string): string {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return (h >>> 0).toString(36);
}

/*
 * The agent replaces the end of any result longer than maxResultChars + 500 with a generic
 * notice, which cuts off whatever a tool put last: a "call again with offset=N" marker, a
 * verdict, a "N more" line. So every tool keeps its whole result within ctx.maxResultChars
 * itself, and what it leaves out it says in its own words.
 */

/** The smallest page a paged read returns, however much else is in the result. */
function minPage(limit: number): number {
	return Math.max(100, Math.floor(limit / 4));
}

/**
 * One page of `text` from `offset`, sized so that `overhead` (the characters of everything
 * else in the result) plus the page and its continuation marker fit in `limit`. `next` is the
 * offset of the first character not shown, which is what the marker must name; null at the end.
 */
export function pageWithin(
	text: string,
	offset: number,
	limit: number,
	overhead: number,
	marker: (next: number) => string,
): { text: string; marker: string; next: number | null } {
	const floor = minPage(limit);
	if (text.length - offset <= Math.max(floor, limit - overhead)) return { text: text.slice(offset), marker: "", next: null };
	// The marker's length depends on the offset it names; the text's own length has at least as many digits.
	let next = offset + Math.max(floor, limit - overhead - marker(text.length).length);
	// Never split a surrogate pair (an emoji) across two pages.
	const last = text.charCodeAt(next - 1);
	if (last >= 0xd800 && last <= 0xdbff) next--;
	return { text: text.slice(offset, next), marker: marker(next), next };
}

/** "a, b, c" cut to `maxItems` names and about `maxChars` characters, saying how many were left out. */
function nameList(items: string[], maxItems: number, maxChars: number): string {
	const kept: string[] = [];
	let chars = 0;
	for (const item of items) {
		if (kept.length >= maxItems || (kept.length > 0 && chars + item.length + 2 > maxChars)) break;
		kept.push(item);
		chars += item.length + 2;
	}
	return kept.join(", ") + (kept.length < items.length ? `, … (+${items.length - kept.length} more)` : "");
}

/** How many of the leading `rows` fit in `budget` characters when joined with a separator of `sep` characters. */
function fitCount(rows: string[], budget: number, sep = 1): number {
	let used = 0;
	for (let i = 0; i < rows.length; i++) {
		used += rows[i].length + (i ? sep : 0);
		if (used > budget) return i;
	}
	return rows.length;
}

/**
 * A list result: `head`, the rows that fit in `max` characters, and how many of `total` are
 * not shown. `rows` holds the first `limit` entries; the rest were already left out by the limit.
 */
function listWithin(head: string, rows: string[], total: number, max: number): string {
	const worst = `\n…and ${total} more. Narrow the filter or raise the limit.`;
	const keep = Math.max(1, fitCount(rows, max - head.length - worst.length));
	const more = total > keep ? `\n…and ${total - keep} more. Narrow the filter${keep < rows.length ? "" : " or raise the limit"}.` : "";
	return `${head}${rows.slice(0, keep).join("\n")}${more}`;
}

/** Rows grouped under the note they belong to: "path\n  row\n  row". */
interface RowBlock {
	path: string;
	rows: string[];
}

/** As many whole rows of `blocks` as fit in `budget` characters; a path line is never shown without a row. */
function fitBlocks(blocks: RowBlock[], budget: number): { text: string; rows: number; chars: number } {
	const out: string[] = [];
	let chars = 0;
	let rows = 0;
	outer: for (const b of blocks) {
		for (let i = 0; i < b.rows.length; i++) {
			const add = (i === 0 ? b.path.length + 1 : 0) + b.rows[i].length + 1;
			if (chars + add > budget) break outer;
			if (i === 0) out.push(b.path);
			out.push(b.rows[i]);
			chars += add;
			rows++;
		}
	}
	return { text: out.join("\n"), rows, chars };
}

/** The most of one line that grep_vault prints. A prose paragraph is a single line in Obsidian, so a few uncut matches could fill the result. */
const GREP_LINE_CHARS = 240;
/** find_in_note is used to copy text for an edit, so it shows more of the matching line and less of its neighbours. */
const FIND_LINE_CHARS = 400;
const FIND_CONTEXT_CHARS = 160;

/**
 * A long line cut to about `max` characters around the match that starts at `at`, each cut
 * marked with "…". A quarter of the window comes before the match so it reads in context.
 */
export function clipLine(line: string, max: number, at = 0): string {
	// Cutting off a few characters saves nothing and costs the reader the end of the sentence.
	if (line.length <= max + 40) return line;
	let start = Math.max(0, at - Math.floor(max / 4));
	if (start + max >= line.length) start = line.length - max;
	else if (start > 0) {
		// Start at a word when one begins nearby, before the match.
		const space = line.indexOf(" ", start);
		if (space >= 0 && space < Math.min(at, start + 24)) start = space + 1;
	}
	if (start < 24) start = 0;
	const end = Math.min(line.length, start + max);
	return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

/** A passage is not shown shorter than this unless it is shorter itself; lower-ranked ones are left out instead. */
const MIN_PASSAGE_CHARS = 600;
const PASSAGE_CUT = "\n[… section truncated; read_section for the rest]";

async function requestApproval(ctx: ToolContext, req: ApprovalRequest): Promise<void> {
	const decision = await ctx.approve(req);
	if (decision === "reject") {
		throw new ToolError("REJECTED: the user declined this change in the approval dialog, so nothing was written. Do not retry it or a variant of it. Tell the user which change was rejected and ask what they would like instead, then stop.");
	}
	// Stopped while the dialog was open: an approval that arrives after Stop writes nothing.
	if (ctx.signal?.aborted) throw new ToolError("Stopped before writing; nothing was written.");
	// The diff shown was computed from the note as it was; if the user (or another plugin) changed
	// it while the dialog was open, writing now would silently undo their edit.
	if (CONTENT_TOOLS.has(req.tool)) {
		const now = ctx.vault.exists(req.path) ? await ctx.vault.read(req.path) : null;
		const expected = req.tool === "create_note" ? null : req.before;
		if (now !== expected) {
			throw new ToolError(`${req.path} ${expected === null ? "was created" : "changed"} while the change was waiting for approval, so nothing was written. Read it again and redo the edit on the current text.`);
		}
	}
}

/** Tools whose approval request carries the note's full text before and after. */
const CONTENT_TOOLS = new Set(["create_note", "edit_note", "edit_notes", "append_to_note", "replace_section", "replace_note"]);

export const searchNotes: ToolDefinition = {
	name: "search_notes",
	description:
		"Search the vault for notes relevant to a query by meaning and keywords. Returns note paths with a short snippet; results are ranked, not exhaustive. For every note containing an exact string, tag or frontmatter value (e.g. 'status: done'), use grep_vault instead.",
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "What to look for. A natural-language phrase or keywords." },
			limit: { type: "integer", description: "Maximum results to return (default 8, max 25)." },
		},
		required: ["query"],
	},
	mutates: false,
	async execute(args, ctx) {
		const query = str(args, "query");
		const limit = int(args, "limit", 8, 1, 25);
		const hits = await ctx.search(query, limit);
		if (hits.length === 0) return `No notes matched "${query}". Try different keywords or list_notes.`;
		// Plain text like every other tool, in search_passages' layout: "--- [n] path › heading" and the snippet under it.
		const rows = hits.map((h, i) => `--- [${i + 1}] ${h.path}${h.heading ? ` › ${h.heading}` : ""}\n${h.snippet}`);
		const head = (n: number) => `${n} note${n === 1 ? "" : "s"}, best first. Each snippet is a short excerpt, not the note's text.\n`;
		const keep = Math.max(1, fitCount(rows, ctx.maxResultChars - head(rows.length).length));
		return head(keep) + rows.slice(0, keep).join("\n");
	},
};

export const searchPassages: ToolDefinition = {
	name: "search_passages",
	description:
		"Search by meaning and by exact words (names, numbers, identifiers, a day such as 'September 10' or 'yesterday') that returns the best-matching sections of notes verbatim (a heading's paragraphs, not a whole note). Each is labelled 'note › heading path'. Usually enough to answer a question directly; cite the note path. Use search_notes instead when you only need to know which notes exist on a topic.",
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "What to look for, phrased like the content you expect (a question or a statement)." },
			limit: { type: "integer", description: "Maximum passages to return (default 6, max 20)." },
		},
		required: ["query"],
	},
	mutates: false,
	async execute(args, ctx) {
		const query = str(args, "query");
		const limit = int(args, "limit", 6, 1, 20);
		const passages = ctx.searchPassages ? await ctx.searchPassages(query, limit) : [];
		if (passages.length === 0) {
			// No index (disabled, still building, or model missing): fall back to keyword hits.
			const hits = await ctx.search(query, limit);
			if (hits.length === 0) return `No passages matched "${query}". Try other words, or list_notes.`;
			const rows = hits.map((h, i) => `--- [${i + 1}] ${h.path}${h.heading ? ` › ${h.heading}` : ""}\n${h.snippet}`);
			const head = "The semantic index is not available, so these are keyword matches with short snippets (use read_note or read_section for the text):\n";
			return head + rows.slice(0, Math.max(1, fitCount(rows, ctx.maxResultChars - head.length))).join("\n");
		}
		// When nothing is close in meaning and no passage has the question's words, say so: six
		// plausible-looking passages otherwise read as "the answer is in here somewhere".
		const best = Math.max(...passages.map((p) => p.score));
		const weak = ctx.weakMatchBelow !== undefined && best < ctx.weakMatchBelow && !passages.some((p) => p.words && p.words.matched === p.words.terms);
		const note = weak
			? `\nNone of these is a close match (best score ${best.toFixed(2)}): the vault may have nothing on this. If no passage answers the question, say the notes do not cover it rather than guessing; try grep_vault with an exact word if there is one.`
			: "";
		const intro = (n: number, left: number) =>
			`${n} passage${n === 1 ? "" : "s"}, best first${left ? ` (${left} lower-ranked left out to fit; ask again with a narrower query for those)` : ""}. Each is one section of a note; cite the note path as a wikilink.${note}`;
		const heads = passages.map((p, i) => {
			const where = p.crumb ?? p.heading;
			return `\n--- [${i + 1}] ${p.path}${where ? ` › ${where}` : ""} (score ${p.score.toFixed(2)})\n`;
		});
		// The passages share what the result can hold. Ranked best first, so when they cannot all
		// have a useful length it is the last ones that are left out, and the first line says so.
		const room = ctx.maxResultChars - intro(passages.length, passages.length).length;
		let shown = 0;
		let fixed = 0;
		let least = 0;
		for (let i = 0; i < passages.length; i++) {
			const need = heads[i].length + PASSAGE_CUT.length;
			const text = Math.min(passages[i].text.length, MIN_PASSAGE_CHARS);
			if (shown > 0 && fixed + need + least + text > room) break;
			fixed += need;
			least += text;
			shown++;
		}
		// Short passages are shown whole; the long ones split what the short ones leave.
		const caps = new Array<number>(shown).fill(0);
		let left = room - fixed;
		const byLength = caps.map((_, i) => i).sort((a, b) => passages[a].text.length - passages[b].text.length);
		byLength.forEach((i, k) => {
			caps[i] = Math.min(passages[i].text.length, Math.max(200, Math.floor(left / (shown - k))));
			left -= caps[i];
		});
		const rows = caps.map((cap, i) => heads[i] + (passages[i].text.length > cap ? passages[i].text.slice(0, cap) + PASSAGE_CUT : passages[i].text));
		return intro(shown, passages.length - shown) + rows.join("");
	},
};

/**
 * The body of one heading in `content`: from the heading line to the next heading of the same or
 * a higher level. `heading` is the heading's text, or a path of headings ("2026-09-10 › Summary",
 * also written with ">" or "#") for a note that repeats a heading under each date or topic. A
 * heading that matches exactly wins over one that only starts with the text, wherever it is.
 */
export function extractSection(content: string, heading: string): { text: string; startLine: number; endLine: number } | null {
	const lines = content.split("\n");
	const parts = heading
		.replace(/^#+\s*/, "")
		.split(/\s+[›>]\s+|\s*#\s*/)
		.map((p) => p.trim().toLowerCase())
		.filter(Boolean);
	if (parts.length === 0) return null;
	const whole = heading.replace(/^#+\s*/, "").trim().toLowerCase();
	const heads: { line: number; level: number; text: string; above: string[] }[] = [];
	const stack: { level: number; text: string }[] = [];
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
		if (inFence) continue;
		const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
		if (!m) continue;
		const level = m[1].length;
		while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
		const text = m[2].trim().toLowerCase();
		heads.push({ line: i, level, text, above: stack.map((s) => s.text) });
		stack.push({ level, text });
	}
	/** The headings above `h` contain `path` in order (levels in between may be skipped). */
	const under = (h: { above: string[] }, path: string[]): boolean => {
		let at = 0;
		for (const a of h.above) if (at < path.length && (a === path[at] || a.startsWith(path[at]))) at++;
		return at === path.length;
	};
	const last = parts[parts.length - 1];
	const parents = parts.slice(0, -1);
	const found =
		// A heading whose own text is the whole argument (it may itself contain ">" or "#").
		heads.find((h) => h.text === whole) ??
		(parents.length ? (heads.find((h) => h.text === last && under(h, parents)) ?? heads.find((h) => h.text.startsWith(last) && under(h, parents))) : undefined) ??
		heads.find((h) => h.text === last && parents.length === 0) ??
		heads.find((h) => h.text.startsWith(whole));
	if (!found) return null;
	const next = heads.find((h) => h.line > found.line && h.level <= found.level);
	const end = next ? next.line : lines.length;
	return { text: lines.slice(found.line, end).join("\n").trimEnd(), startLine: found.line + 1, endLine: end };
}

export const grepVault: ToolDefinition = {
	name: "grep_vault",
	description:
		"Search every note's text for a literal string (case-insensitive) or a regular expression (set regex: true for ^, \\s, [A-Z], a|b). Returns matching lines as `path:line [enclosing heading]: text` grouped by note, a long line cut around the match. The right tool for 'every note that contains X', embeds, tags, headings or exact phrases; much cheaper than reading notes. With a heading as the pattern and context: 8 it shows the start of that section in every note at once.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Literal text, or a regular expression when regex is true." },
			regex: { type: "boolean", description: "Pattern is a JavaScript regular expression." },
			folder: { type: "string", description: "Only notes inside this folder (recursive)." },
			context: { type: "integer", description: "Lines to show after each match (default 0, max 8)." },
			limit: { type: "integer", description: "Maximum matching lines (default 60, max 200)." },
			notes_only: { type: "boolean", description: "Only list the notes that match, with a count each: for 'which notes contain X'." },
		},
		required: ["pattern"],
	},
	mutates: false,
	async execute(args, ctx) {
		const rawPattern = str(args, "pattern");
		const useRegex = bool(args, "regex");
		const folder = str(args, "folder", false).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
		const context = int(args, "context", 0, 0, 8);
		const limit = int(args, "limit", 60, 1, 200);
		const notesOnly = bool(args, "notes_only") || bool(args, "count_only") || bool(args, "paths_only");
		let notes = ctx.vault.listNotes();
		if (folder) {
			// The folder wins when it exists: "Daily" must mean the Daily/ folder even when a note
			// called Daily.md (the daily template, say) would resolve. Only a name that matches no
			// folder is taken as a single note.
			const inFolder = notes.filter((n) => n.path.toLowerCase().startsWith(folder + "/"));
			if (inFolder.length) notes = inFolder;
			else {
				const single = ctx.vault.resolve(str(args, "folder", false));
				// Neither a folder nor a note: say so, or "No note contains X under folder/" reads as a true negative.
				const missing = single ? null : missingFolderHint(ctx.vault, str(args, "folder", false));
				if (missing) throw new ToolError(`${missing} Nothing was searched.`);
				notes = single ? notes.filter((n) => n.path === single) : [];
			}
		}
		notes.sort((a, b) => a.path.localeCompare(b.path));

		/**
		 * `find` returns where in the line the match starts, or -1. Notes are read a batch at a
		 * time, never the whole vault at once. With `timed` (a regular expression) the search
		 * stops once the matching itself has taken REGEX_BUDGET_MS: this runs on the UI thread.
		 */
		const scan = async (find: (line: string) => number, timed: boolean) => {
			/** One matching line with its context lines, for the first `limit` matches. */
			const hits: { path: string; rows: string[] }[] = [];
			let total = 0;
			/** Every note with at least one matching line, shown or not, and how many it has. */
			const perNote: { path: string; count: number }[] = [];
			let searched = 0;
			let spent = 0;
			/** Lines too long for a regular expression to be tried on all of. */
			let capped = 0;
			batches: for (let from = 0; from < notes.length; from += READ_BATCH) {
				if (ctx.signal?.aborted) throw new ToolError("Stopped.");
				const batch = notes.slice(from, from + READ_BATCH);
				const texts = await Promise.all(batch.map((n) => ctx.vault.read(n.path)));
				for (let k = 0; k < batch.length; k++) {
					if (timed && spent > REGEX_BUDGET_MS) break batches;
					const started = performance.now();
					const n = batch[k];
					const lines = texts[k].split("\n");
					let inNote = 0;
					let heading = "";
					let inFence = false;
					for (let i = 0; i < lines.length; i++) {
						if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
						const h = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
						if (h) heading = `${h[1]} ${h[2].trim()}`;
						if (timed && lines[i].length > MAX_REGEX_LINE) capped++;
						const at = find(lines[i]);
						if (at < 0) continue;
						total++;
						inNote++;
						if (notesOnly || hits.length >= limit) continue;
						const rows = [`${n.path}:${i + 1}${heading && !h ? ` [${heading}]` : ""}: ${clipLine(lines[i], GREP_LINE_CHARS, at)}`];
						for (let j = i + 1; j <= Math.min(lines.length - 1, i + context); j++) rows.push(`${n.path}:${j + 1}- ${clipLine(lines[j], GREP_LINE_CHARS)}`);
						hits.push({ path: n.path, rows });
					}
					if (inNote) perNote.push({ path: n.path, count: inNote });
					searched++;
					spent += performance.now() - started;
				}
			}
			return { hits, total, perNote, searched, capped };
		};
		const literal = (p: string) => {
			const lower = p.toLowerCase();
			return (line: string) => line.toLowerCase().indexOf(lower);
		};

		let note = "";
		let pattern = rawPattern;
		let result;
		if (useRegex) {
			pattern = tidyAlternation(rawPattern);
			const re = compileRegex(pattern);
			if (re) {
				result = await scan(regexFinder(re), true);
			} else {
				note = `(The pattern is not a valid regular expression: ${tryRegexError(pattern)}. Searched for it as literal text instead.)\n`;
				result = await scan(literal(rawPattern), false);
			}
		} else {
			result = await scan(literal(rawPattern), false);
			if (result.total === 0 && looksLikeRegex(rawPattern)) {
				// Models send `^\s*>` or `a|b` with regex:false. Nothing contains that literally, so
				// try it as the regex it clearly is before reporting "no note contains". One that
				// is not safe to run is simply not tried: the literal search already answered.
				pattern = tidyAlternation(rawPattern);
				const re = unsafeRegex(pattern) ? null : compileRegex(pattern);
				if (re) {
					const asRegex = await scan(regexFinder(re), true);
					if (asRegex.total > 0 || asRegex.searched < notes.length) {
						note = `(No line contains that text literally; it looks like a regular expression, so it was searched as one${pattern !== rawPattern ? `, as ${JSON.stringify(pattern)}` : ""}.)\n`;
						result = asRegex;
					} else {
						note = "(Searched both as literal text and as a regular expression.)\n";
					}
				}
			}
		}
		// A regular expression that ran out of time: what follows is from the notes searched so far, and must say so.
		const partial =
			result.searched < notes.length
				? `(This pattern is slow: the search was stopped after ${REGEX_BUDGET_MS / 1000} s with ${result.searched} of ${notes.length} notes searched, so the result is incomplete. Narrow with folder or use a simpler pattern.)\n`
				: "";
		note = partial + note;
		if (result.capped) note += `(${result.capped} line${result.capped === 1 ? "" : "s"} longer than ${MAX_REGEX_LINE} characters ${result.capped === 1 ? "was" : "were"} only searched up to there.)\n`;
		if (result.total === 0) return partial ? `${note}No match in the notes searched so far.` : `${note}No note contains "${rawPattern}"${folder ? ` under ${folder}/` : ""}.`;
		const { hits, total, perNote } = result;
		const counts = `${note}${total} matching line${total === 1 ? "" : "s"} in ${perNote.length} note${perNote.length === 1 ? "" : "s"}`;
		if (notesOnly) {
			// "Which notes contain X": every note fits where their lines would not.
			perNote.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
			const head = `${counts} (lines per note):\n`;
			const rows = perNote.map((p) => `${p.path}: ${p.count}`);
			const keep = Math.max(1, fitCount(rows, ctx.maxResultChars - head.length - `\n…and ${rows.length} more notes; narrow with folder.`.length));
			return `${head}${rows.slice(0, keep).join("\n")}${rows.length > keep ? `\n…and ${rows.length - keep} more notes; narrow with folder.` : ""}`;
		}
		const head = `${counts}:\n`;
		// Many matches with context usually means "which of these sections also has X": that is
		// one list_sections call, not a reading tour.
		const hint =
			total >= 8 && context > 0
				? `\nTo know which of these sections also contain (or lack) another text, call list_sections({containing: [${JSON.stringify(rawPattern)}, "<other text>"]}) once instead of reading them.`
				: "";
		const more = (n: number, full: boolean) => (n > 0 ? `\n…${n} more matching lines not shown; narrow with folder or ${full ? "a more specific pattern, or set notes_only: true for every note" : "raise the limit"}.` : "");
		// Whole matches (a line with its context) while they fit, so the count of what is not
		// shown and the hint are never cut off by a result that is too long.
		const budget = ctx.maxResultChars - head.length - hint.length - more(total, true).length;
		const out: string[] = [];
		let used = 0;
		for (const hit of hits) {
			const sep = out.length === 0 ? "" : hit.path === hits[out.length - 1].path ? "\n" : "\n--\n";
			let text = hit.rows.join("\n");
			if (used + sep.length + text.length > budget) {
				if (out.length > 0) break;
				// Not even one match with its context fits: the match and the context lines that do.
				text = hit.rows.slice(0, Math.max(1, fitCount(hit.rows, budget))).join("\n");
			}
			out.push(sep + text);
			used += sep.length + text.length;
		}
		return `${head}${out.join("")}${more(total - out.length, out.length < hits.length)}${hint}`;
	},
};

function tryRegexError(pattern: string): string {
	try {
		new RegExp(pattern, "i");
		return "";
	} catch (err) {
		return (err as Error).message;
	}
}

/*
 * Regular expressions come from the model and run on the UI thread, where nothing can
 * interrupt one. Three bounds keep a bad pattern from freezing Obsidian: patterns that can
 * backtrack exponentially are refused before they run (unsafeRegex), a line is only matched
 * up to MAX_REGEX_LINE characters, and a vault-wide search stops after REGEX_BUDGET_MS of
 * matching and returns what it has.
 */

/** No search of notes needs a longer pattern, and compiling is not free either. */
const MAX_REGEX_CHARS = 300;
/** A regular expression only sees this much of one line (a polynomial pattern on a 100,000-character line is a freeze too). */
const MAX_REGEX_LINE = 10_000;
/** Matching time after which a vault-wide regular expression search returns what it has. */
export const REGEX_BUDGET_MS = 3000;
/** Notes read at a time by grep_vault. */
const READ_BATCH = 32;

/** The quantifier at `i` (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`): its length in the pattern and how many rounds it allows. */
function quantifierAt(pattern: string, i: number): { length: number; min: number; max: number } | null {
	const c = pattern[i];
	if (c === "*") return { length: 1, min: 0, max: Infinity };
	if (c === "+") return { length: 1, min: 1, max: Infinity };
	if (c === "?") return { length: 1, min: 0, max: 1 };
	const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(i, i + 24));
	if (!m) return null;
	const min = Number(m[1]);
	return { length: m[0].length, min, max: m[2] ? (m[3] ? Number(m[3]) : Infinity) : min };
}

/** What is known about a group while its pattern is being read. */
interface RegexGroup {
	/** Source of every atom inside whose length can vary (`a+`, `b?`, `c{1,4}`): what makes a round of the group ambiguous. */
	repeats: string[];
	/** Has a top-level `|`, at these positions. */
	alt: boolean;
	bars: number[];
	/** Too involved to reason about: a repeat inside a repeated or alternating group inside this one. */
	deep: boolean;
	/** The last atom: its literal character when it is one, and whether a quantifier follows it. */
	last: { literal: string | null; quantified: boolean } | null;
	/** Where the group opens, and where its contents start (after "(" or "(?:"). */
	start: number;
	body: number;
}

/**
 * Why a regular expression must not be run, or null when it may. Refused: a pattern over
 * MAX_REGEX_CHARS, and a repeated group that itself contains a repeat or an optional part —
 * `(a+)+`, `(\w+\s?)*`, `(.*,)+`, `(ab?)+` — which JavaScript's backtracking matcher can take
 * exponential time to fail on. One shape of that is safe and common enough to allow: a group
 * that ends in a literal character none of its variable parts can match (`(\d+\.)+`,
 * `([^,]*,)+`), since each round then ends at exactly one place. Repeated plain-text
 * alternatives where one begins another (`(a|ab)+`) are refused as well. This is a guard
 * against accidents, not a proof: nothing can interrupt a match once it runs, and the line cap
 * and the time budget only bound patterns that are slow rather than explosive. An invalid
 * pattern is not this function's business: null.
 */
export function unsafeRegex(pattern: string): string | null {
	if (pattern.length > MAX_REGEX_CHARS) return `it is ${pattern.length} characters long (the most is ${MAX_REGEX_CHARS})`;
	const nested = "it repeats a group that has a repeat inside it, like (a+)+ or (\\w+\\s?)*, which can freeze on a long line; use one repeat, such as [\\w ]+";
	const matches = (atom: string, ch: string): boolean => {
		try {
			return new RegExp(`^(?:${atom})$`, "i").test(ch);
		} catch {
			return true;
		}
	};
	const risky = (g: RegexGroup, end: number): boolean => {
		if (g.repeats.length === 0) {
			// Plain-text alternatives where one begins another, (a|ab)+, split the same text in many ways too.
			if (!g.alt) return false;
			const alts = [...g.bars, end].map((bar, k) => pattern.slice(k === 0 ? g.body : g.bars[k - 1] + 1, bar).toLowerCase());
			if (alts.some((a) => /[\\()[\]{}.*+?^$]/.test(a))) return false;
			return alts.some((a, k) => alts.some((b, j) => j !== k && b.startsWith(a)));
		}
		if (g.deep || g.alt || !g.last || g.last.quantified || g.last.literal === null) return true;
		const last = g.last.literal;
		return g.repeats.some((r) => matches(r, last));
	};
	const open = (start: number, body: number): RegexGroup => ({ repeats: [], alt: false, bars: [], deep: false, last: null, start, body });
	const stack: RegexGroup[] = [open(0, 0)];
	let i = 0;
	while (i < pattern.length) {
		const top = stack[stack.length - 1];
		const c = pattern[i];
		/** The atom that ends just before `i`: its source, its literal character if it is one, and the group it closed. */
		let atom: { src: string; literal: string | null; group?: RegexGroup };
		if (c === "\\") {
			const src = pattern.slice(i, i + 2);
			atom = { src, literal: /^\\[^a-zA-Z0-9]$/.test(src) ? src[1] : null };
			i += 2;
		} else if (c === "[") {
			let j = i + 1;
			if (pattern[j] === "^") j++;
			if (pattern[j] === "]") j++;
			while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
			atom = { src: pattern.slice(i, j + 1), literal: null };
			i = j + 1;
		} else if (c === "(") {
			// "(?:", "(?=", "(?!", "(?<=", "(?<!", "(?<name>": the "?" is not a quantifier.
			const prefix = /^\?(?:[:=!]|<[=!]|<[^>]*>)/.exec(pattern.slice(i + 1, i + 41));
			stack.push(open(i, i + 1 + (prefix ? prefix[0].length : 0)));
			i = stack[stack.length - 1].body;
			continue;
		} else if (c === ")") {
			i++;
			if (stack.length === 1) continue;
			const group = stack.pop() as RegexGroup;
			const parent = stack[stack.length - 1];
			parent.repeats.push(...group.repeats);
			if (group.deep || (group.alt && group.repeats.length > 0)) parent.deep = true;
			atom = { src: pattern.slice(group.start, i), literal: null, group };
		} else if (c === "|") {
			top.alt = true;
			top.bars.push(i);
			top.last = null;
			i++;
			continue;
		} else if (c === "^" || c === "$") {
			top.last = null;
			i++;
			continue;
		} else {
			atom = c === "." ? { src: ".", literal: null } : { src: /[*+?{}]/.test(c) ? `\\${c}` : c, literal: c };
			i++;
		}
		const parent = stack[stack.length - 1];
		parent.last = { literal: atom.literal, quantified: false };
		const q = quantifierAt(pattern, i);
		if (!q) continue;
		// Three or more rounds of a group that can be split up in more than one way is the danger.
		if (q.max >= 3 && atom.group) {
			if (risky(atom.group, i - 1)) return nested;
			if (atom.group.repeats.length) parent.deep = true;
		}
		if (q.max > q.min) {
			parent.repeats.push(atom.src);
			parent.last.quantified = true;
		}
		// A lazy suffix ("+?", "*?") changes nothing here.
		i += q.length + (pattern[i + q.length] === "?" ? 1 : 0);
	}
	return null;
}

/** The pattern compiled case-insensitively; null when it is not a valid regular expression. Throws for one that is not safe to run. */
function compileRegex(pattern: string): RegExp | null {
	let re: RegExp;
	try {
		re = new RegExp(pattern, "i");
	} catch {
		return null;
	}
	const why = unsafeRegex(pattern);
	if (why) throw new ToolError(`This regular expression was not run: ${why}. Or search for a literal word.`);
	return re;
}

/** Where in a line the expression first matches, or -1; only the first MAX_REGEX_LINE characters of a line are looked at. */
function regexFinder(re: RegExp): (line: string) => number {
	return (line) => re.exec(line.length > MAX_REGEX_LINE ? line.slice(0, MAX_REGEX_LINE) : line)?.index ?? -1;
}

/** True when a pattern sent as literal text is almost certainly meant as a regular expression. */
export function looksLikeRegex(pattern: string): boolean {
	// Anchors, classes, escapes of regex metacharacters (`!\[\[Recording`), quantifiers, groups, alternation.
	return /^\^|\$$|\\[sdwbSDWB]|\\[[\]().|+*?{}]|\[[^\]]+\]|\.[*+?]|\(\?|\||\{\d+(,\d*)?\}/.test(pattern);
}

/** `scp | salloc | module load` → `scp|salloc|module load`: a model's spaces around `|` are
 * never meant to be part of the alternatives. */
export function tidyAlternation(pattern: string): string {
	if (!pattern.includes("|")) return pattern;
	const parts = pattern.split("|");
	if (!parts.some((p) => p !== p.trim())) return pattern;
	return parts.map((p) => p.trim()).join("|");
}

export const listSections: ToolDefinition = {
	name: "list_sections",
	description:
		"Survey sections across many notes without reading them, in ONE call for the whole vault or folder. containing: ['![[Recording', '### Summary'] flags for every section which of those texts it has, so 'sections with X but not Y' is answered at once (pass all the texts you care about together; never one call per section or per note; then edit with edit_notes using heading + line_contains). heading: 'Capture' with a folder lists that section of every note with its size and first line — which daily notes have a full inbox and which are empty. Give containing, heading, or both.",
	parameters: {
		type: "object",
		properties: {
			heading: { type: "string", description: "Only sections whose heading starts with this text (case-insensitive), e.g. 'Capture'." },
			containing: { type: "array", description: "Up to 4 texts to test each section for (case-insensitive, literal).", items: { type: "string" } },
			folder: { type: "string", description: "Only notes inside this folder (recursive)." },
			path: { type: "string", description: "Only this note." },
			level: { type: "integer", description: "Only headings of this level (2 = '##'). Default: all levels." },
			only_matching: { type: "boolean", description: "With containing: only list sections that contain at least one of the texts (default true)." },
			limit: { type: "integer", description: "Maximum sections to return (default 150, max 400)." },
		},
	},
	mutates: false,
	async execute(args, ctx) {
		let raw: unknown = args.containing;
		// Models sometimes send the list as text: "['![[Recording', '### Summary']". Read it as a list.
		if (typeof raw === "string" && /^\s*\[.*\]\s*$/s.test(raw)) {
			const text: string = raw;
			try {
				raw = JSON.parse(text.replace(/'/g, '"'));
			} catch {
				raw = text
					.trim()
					.slice(1, -1)
					.split(/\s*,\s*/)
					.map((x: string) => x.trim().replace(/^['"]|['"]$/g, ""));
			}
		}
		const wantHeading = str(args, "heading", false).replace(/^#+\s*/, "").trim().toLowerCase();
		// Models send containing: ["## Capture"] together with heading: "Capture". The heading line
		// is not part of a section's body, so that text would match nothing; it means the heading.
		const needles = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
			.map((x) => String(x).trim())
			.filter(Boolean)
			.filter((x) => !wantHeading || x.replace(/^#+\s*/, "").trim().toLowerCase() !== wantHeading)
			.slice(0, 4);
		if (needles.length === 0 && !wantHeading) throw new ToolError("Give heading (a section to survey) and/or containing (1–4 texts to test for).");
		const folder = str(args, "folder", false).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
		const only = str(args, "path", false);
		const level = int(args, "level", 0, 0, 6);
		const onlyMatching = needles.length > 0 && bool(args, "only_matching", true);
		const limit = int(args, "limit", 150, 1, 400);
		let notes = ctx.vault.listNotes();
		if (only) {
			const p = resolveExisting(ctx.vault, only);
			notes = notes.filter((n) => n.path === p);
		}
		if (folder) {
			const inFolder = notes.filter((n) => n.path.toLowerCase().startsWith(folder + "/"));
			// As in grep_vault: a name that is no folder is taken as a note, and one that is neither is reported.
			const single = inFolder.length || only ? null : ctx.vault.resolve(str(args, "folder", false));
			const missing = inFolder.length || single ? null : missingFolderHint(ctx.vault, str(args, "folder", false));
			if (missing) throw new ToolError(`${missing} Nothing was searched.`);
			notes = single ? notes.filter((n) => n.path === single) : inFolder;
		}
		notes.sort((a, b) => a.path.localeCompare(b.path));
		const lowers = needles.map((n) => n.toLowerCase());
		const blocks: RowBlock[] = [];
		let shown = 0;
		let total = 0;
		/** Sections that matched the heading/level filter before the `containing` test. */
		let candidates = 0;
		/** Sections that contain every one of the texts (when two or more were given). */
		let withAll = 0;
		/** `path › heading` of those sections, listed again at the end so they can be copied as edit targets. */
		const marked: string[] = [];
		/** Notes whose rows have only some of the texts (grouped mode). */
		const someBlocks: RowBlock[] = [];
		for (const n of notes) {
			const lines = (await ctx.vault.read(n.path)).split("\n");
			// A section runs to the next heading of the same or a higher level, so nested
			// sub-headings (e.g. "### Summary" under "## 2026-09-02") count as part of it.
			const heads: { heading: string; lvl: number; line: number }[] = [];
			let inFence = false;
			for (let i = 0; i < lines.length; i++) {
				if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
				const h = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
				if (h) heads.push({ heading: h[2].trim(), lvl: h[1].length, line: i });
			}
			const rows: string[] = [];
			/** With two or more texts the rows are grouped: every text vs only some. */
			const someRows: string[] = [];
			const grouped = needles.length > 1 && !wantHeading;
			// Each section's extent and flags, computed once: a parent whose match comes only from
			// a child (the note's "# Title" contains every "## date" section) must not be reported,
			// or the model edits "heading: <note title>" and takes every recording in the note.
			const info = heads.map((s, k) => {
				let end = lines.length;
				for (let j = k + 1; j < heads.length; j++) {
					if (heads[j].lvl <= s.lvl) {
						end = heads[j].line;
						break;
					}
				}
				const bodyLines = lines.slice(s.line + 1, end);
				const body = bodyLines.join("\n");
				const flags = lowers.map((l) => body.toLowerCase().includes(l));
				return { s, end, bodyLines, body, flags };
			});
			const shadowed = (k: number): boolean => {
				const { s, end, flags } = info[k];
				if (!needles.length || wantHeading || !flags.some(Boolean)) return false;
				return info.some((c) => c.s.line > s.line && c.s.line < end && c.s.lvl > s.lvl && c.flags.some(Boolean) && flags.every((f, i) => !f || c.flags[i]));
			};
			for (let k = 0; k < heads.length; k++) {
				const { s, bodyLines, body, flags } = info[k];
				if (level && s.lvl !== level) continue;
				if (wantHeading && !s.heading.toLowerCase().startsWith(wantHeading)) continue;
				if (shadowed(k)) continue;
				candidates++;
				if (onlyMatching && !flags.some(Boolean)) continue;
				total++;
				// Counted before the limit, so the two group counts add up to the total whatever is listed.
				const hasAll = needles.length > 1 && flags.every(Boolean);
				if (hasAll) withAll++;
				if (shown >= limit) continue;
				shown++;
				let row = `  ${"#".repeat(s.lvl)} ${s.heading}`;
				if (wantHeading) {
					// Survey mode: how much is under the heading and what it starts with.
					const nonEmpty = bodyLines.filter((l) => l.trim());
					const first = (nonEmpty[0] ?? "").trim();
					row += nonEmpty.length === 0 ? " (empty)" : ` (${nonEmpty.length} line${nonEmpty.length === 1 ? "" : "s"}, ${body.trim().length} chars): ${first.length > 100 ? first.slice(0, 99) + "…" : first}`;
				}
				// Only yes/no per text: quoting the matching line here made the model paste the whole
				// row into edit_notes' line_contains. The needle itself is what line_contains needs.
				if (needles.length) row += `${wantHeading ? " |" : ":"} ${needles.map((t, i) => `${t} ${flags[i] ? "yes" : "no"}`).join(", ")}`;
				if (hasAll) {
					row += " → all";
					if (marked.length < 80) marked.push(`${n.path} › ${s.heading}`);
				}
				if (grouped && !hasAll) someRows.push(row);
				else rows.push(row);
			}
			if (rows.length) blocks.push({ path: n.path, rows });
			if (someRows.length) someBlocks.push({ path: n.path, rows: someRows });
		}
		if (total === 0) {
			const where = folder ? ` under ${folder}/` : "";
			const texts = needles.map((t) => `"${t}"`).join(", ");
			if (onlyMatching && candidates > 0) {
				// The sections exist; none has the text. Say both, or the model concludes the heading is missing.
				return `${candidates} section${candidates === 1 ? "" : "s"}${wantHeading ? ` headed "${wantHeading}"` : ""}${where} exist, but none contains ${texts}. Call again without containing to survey them, or with other texts.`;
			}
			const what = wantHeading ? `No section headed "${wantHeading}"` : "No section";
			return `${what}${onlyMatching ? " contains any of " + texts : wantHeading ? "" : "s found"}${where}.`;
		}
		const legend = wantHeading ? "(non-empty lines, characters, first line)" : needles.length > 1 ? '(flags per text, in order; "→ all" marks a section that has every text)' : "(flags per text, in order)";
		/** The result with at most `rowChars` characters of section rows and `markedChars` of the marked list. */
		const render = (rowChars: number, markedChars: number): { text: string; rowsUsed: number } => {
			const keep = fitCount(marked, markedChars);
			// The flags are the answer: a model that re-reads every section to "check" spends the
			// whole turn reading, so say what to do with the marked ones.
			const verdict =
				needles.length > 1
					? `\n${withAll} section${withAll === 1 ? "" : "s"} marked "→ all" ${withAll === 1 ? "has" : "have"} every text. These flags are exact: act on the marked sections directly (for example edit_notes with path, heading and line_contains set to the text you searched for), without reading them first, and leave the unmarked sections alone.${
							keep ? `\nMarked sections (path › heading):\n${marked.slice(0, keep).join("\n")}${withAll > keep ? `\n…and ${withAll - keep} more` : ""}` : ""
						}`
					: "";
			const first = fitBlocks(blocks, rowChars);
			const second = fitBlocks(someBlocks, rowChars - first.chars);
			const listed = first.rows + second.rows;
			const more = total > listed ? `\n…${total - listed} more sections not shown; narrow with folder/path${total > shown ? " or raise the limit" : ""}.` : "";
			const group = (fit: { text: string; rows: number }, n: number) => (fit.rows ? fit.text : n ? "(not listed, to fit)" : "(none)");
			const part = (fit: { rows: number }, n: number) => (fit.rows > 0 && fit.rows < n ? `, the first ${fit.rows} listed` : "");
			let body: string;
			if (needles.length > 1 && !wantHeading) {
				// Two groups, so "25 sections" can never be read as "25 sections with both".
				const every = `Sections with EVERY text (${withAll}${part(first, withAll)}):\n${group(first, withAll)}`;
				const partial = `Sections with only SOME of the texts (${total - withAll}${part(second, total - withAll)}) — leave these alone when the rule is "has both":\n${group(second, total - withAll)}`;
				body = `${every}\n${partial}`;
			} else body = first.text;
			return { text: `${total} section${total === 1 ? "" : "s"} ${legend}:\n${body}${more}${verdict}`, rowsUsed: first.chars };
		};
		const whole = render(Infinity, Infinity).text;
		if (whole.length <= ctx.maxResultChars) return whole;
		// Too much for one result. What is said last (how many are not shown, the verdict) must
		// survive, so the rows are cut instead: the sections with every text first, then the
		// copyable list of them, and the "only some" group gets what is left.
		const free = ctx.maxResultChars - render(0, 0).text.length - 80;
		const markedChars = marked.reduce((n, m) => n + m.length + 1, 0);
		const forRows = free - Math.min(markedChars, Math.floor(free / 4));
		const forMarked = Math.min(markedChars, free - Math.min(forRows, render(forRows, 0).rowsUsed));
		return render(free - forMarked, forMarked).text;
	},
};

export const readSection: ToolDefinition = {
	name: "read_section",
	description:
		"Read one section of a note: the heading and everything under it up to the next heading of the same or a higher level. Cheaper than read_note for long notes. Heading text is matched case-insensitively; a prefix is enough. When a note repeats a heading (a 'Summary' under every date), give the path as search_passages shows it: '2026-11-05 › Summary'.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the note." },
			heading: { type: "string", description: "The heading text, e.g. 'Open problems' or '2026-11-05', or a path of headings: '2026-11-05 › Summary'." },
		},
		required: ["path", "heading"],
	},
	mutates: false,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const heading = str(args, "heading");
		const content = await ctx.vault.read(path);
		const section = extractSection(content, heading);
		if (!section) {
			const available = ctx.vault.getMetadata(path).headings;
			return `No heading matching "${heading}" in ${path}.${available.length ? ` Headings in this note:\n${available.join("\n")}` : " The note has no headings; use read_note."}`;
		}
		const head = `# ${path} (lines ${section.startLine}–${section.endLine})\n---\n`;
		// Where the section starts in the note, so the marker names the read_note offset that continues exactly where this page stops.
		let startChar = 0;
		const lines = content.split("\n");
		for (let i = 0; i < section.startLine - 1; i++) startChar += lines[i].length + 1;
		const page = pageWithin(
			section.text,
			0,
			ctx.maxResultChars,
			head.length,
			(next) => `\n\n[TRUNCATED at ${next} of ${section.text.length} characters of this section. Call read_note with offset=${startChar + next} to continue.]`,
		);
		return `${head}${page.text}${page.marker}`;
	},
};

export const readNote: ToolDefinition = {
	name: "read_note",
	description:
		"Read the full contents of one note by path (or exact note name), with its tags, links and backlinks. Long notes are paged with `offset`. Costs context: to find which notes mention something use grep_vault or search_passages instead; to read one heading use read_section.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Vault-relative path like 'Projects/Chess Robot.md', or the note name." },
			offset: { type: "integer", description: "Character offset to start reading from (default 0)." },
		},
		required: ["path"],
	},
	mutates: false,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const offset = int(args, "offset", 0, 0, 50_000_000);
		const content = await ctx.vault.read(path);
		const meta = ctx.vault.getMetadata(path);
		const limit = ctx.maxResultChars;
		// The header and the page share one budget: a page of `limit` characters under a long
		// header would be cut by the agent, marker included, and the next offset would skip text.
		const listChars = Math.max(200, Math.floor(limit / 8));
		const header = [
			`# ${path}`,
			meta.tags.length ? `tags: ${nameList(meta.tags, 60, listChars)}` : null,
			meta.links.length ? `links to: ${nameList(meta.links, 30, listChars)}` : null,
			meta.backlinks.length ? `linked from: ${nameList(meta.backlinks, 30, listChars)}` : null,
			`length: ${content.length} characters`,
		]
			.filter(Boolean)
			.join("\n");
		const prefix = offset > 0 ? `[…continuing from character ${offset}]\n` : "";
		let imageNote = "";
		if (ctx.describeImage && offset === 0) {
			const images = imageEmbeds(content);
			if (images.length) imageNote = `\n\n[This note embeds ${images.length} image${images.length === 1 ? "" : "s"} (${nameList(images, 8, 300)}). Its text cannot see them; if what they show matters, read one with read_image.]`;
		}
		const page = pageWithin(
			content,
			offset,
			limit,
			header.length + 5 + prefix.length + imageNote.length,
			(next) => `\n\n[TRUNCATED at character ${next} of ${content.length}. Call read_note again with offset=${next} to continue.]`,
		);
		// Re-reading a note already read in full in this turn only burns context; the first read is still in the conversation.
		if (ctx.readLog && offset === 0 && page.next === null) {
			const stamp = `${content.length}:${hashText(content)}`;
			if (ctx.readLog.get(path) === stamp) {
				return `(unchanged since you read ${path} earlier in this turn; its full text is already above — do not read it again.)`;
			}
			ctx.readLog.set(path, stamp);
		}
		return `${header}\n---\n${prefix}${page.text}${page.marker}${imageNote}`;
	},
};

export const listNotes: ToolDefinition = {
	name: "list_notes",
	description:
		"List notes in the vault, optionally filtered by folder, tag or a substring of the name. Returns every matching path with its size and last-modified date, newest first. The way to learn which notes a folder contains (never guess paths), and the size tells you which notes are nearly empty before you read any.",
	parameters: {
		type: "object",
		properties: {
			folder: { type: "string", description: "Only notes inside this folder (recursive). Omit for the whole vault." },
			tag: { type: "string", description: "Only notes with this tag (with or without '#')." },
			name_contains: { type: "string", description: "Only notes whose name contains this text (case-insensitive)." },
			sort: { type: "string", description: "Sort order.", enum: ["modified", "created", "name", "path"] },
			modified_after: { type: "string", description: "Only notes modified on or after this date (YYYY-MM-DD)." },
			modified_before: { type: "string", description: "Only notes modified before this date (YYYY-MM-DD)." },
			limit: { type: "integer", description: "Maximum results (default 50, max 300)." },
		},
	},
	mutates: false,
	async execute(args, ctx) {
		const folder = str(args, "folder", false).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		const tag = str(args, "tag", false).replace(/^#/, "").toLowerCase();
		const nameContains = str(args, "name_contains", false).toLowerCase();
		const sort = str(args, "sort", false) || "modified";
		const limit = int(args, "limit", 50, 1, 300);
		const after = parseDate(str(args, "modified_after", false));
		const before = parseDate(str(args, "modified_before", false));

		let notes = ctx.vault.listNotes();
		if (after !== null) notes = notes.filter((n) => n.mtime >= after);
		if (before !== null) notes = notes.filter((n) => n.mtime < before);
		if (folder) {
			const prefix = folder.toLowerCase() + "/";
			// Checked against every note, before the other filters: only a folder that is not there is an error.
			if (!ctx.vault.listNotes().some((n) => n.path.toLowerCase().startsWith(prefix))) {
				const missing = missingFolderHint(ctx.vault, folder);
				if (missing) throw new ToolError(missing);
			}
			notes = notes.filter((n) => n.path.toLowerCase().startsWith(prefix));
		}
		if (nameContains) notes = notes.filter((n) => n.basename.toLowerCase().includes(nameContains));
		if (tag) {
			notes = notes.filter((n) =>
				ctx.vault.getMetadata(n.path).tags.some((t) => {
					const lower = t.replace(/^#/, "").toLowerCase();
					return lower === tag || lower.startsWith(tag + "/");
				}),
			);
		}
		switch (sort) {
			case "name":
				notes.sort((a, b) => a.basename.localeCompare(b.basename));
				break;
			case "path":
				notes.sort((a, b) => a.path.localeCompare(b.path));
				break;
			case "created":
				notes.sort((a, b) => b.ctime - a.ctime);
				break;
			default:
				notes.sort((a, b) => b.mtime - a.mtime);
		}
		const total = notes.length;
		const rows = notes.slice(0, limit).map((n) => `${n.path}  (${formatSize(n.size)}, modified ${localDate(n.mtime)})`);
		if (rows.length === 0) return "No notes matched those filters.";
		return listWithin(`${total} note${total === 1 ? "" : "s"}:\n`, rows, total, ctx.maxResultChars);
	},
};

export const vaultOverview: ToolDefinition = {
	name: "vault_overview",
	description:
		"Get a map of the vault: folders with note counts, total notes and the most used tags. Useful to orient yourself before browsing.",
	parameters: { type: "object", properties: {} },
	mutates: false,
	async execute(_args, ctx) {
		const notes = ctx.vault.listNotes();
		const folders = new Map<string, number>();
		const tags = new Map<string, number>();
		for (const n of notes) {
			const top = n.folder === "" ? "(root)" : n.folder.split("/")[0];
			folders.set(top, (folders.get(top) ?? 0) + 1);
			for (const t of ctx.vault.getMetadata(n.path).tags) tags.set(t, (tags.get(t) ?? 0) + 1);
		}
		const folderRows = Array.from(folders.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([f, c]) => `  ${f}/  (${c})`);
		const tagRows = Array.from(tags.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 40)
			.map(([t, c]) => `${t} (${c})`);
		return [
			`Total notes: ${notes.length}`,
			`Top-level folders:`,
			...folderRows,
			tagRows.length ? `Most used tags: ${tagRows.join(", ")}` : "No tags in use.",
		].join("\n");
	},
};

export const getActiveNote: ToolDefinition = {
	name: "get_active_note",
	description:
		"Return the note the user currently has open in the editor (path and contents), plus any text they have selected. Use this when the user says 'this note', 'the current note' or 'my selection'.",
	parameters: { type: "object", properties: {} },
	mutates: false,
	async execute(_args, ctx) {
		const path = ctx.vault.getActiveNotePath();
		if (!path) return "No note is currently open in the editor.";
		const content = await ctx.vault.read(path);
		const limit = ctx.maxResultChars;
		const selection = ctx.vault.getSelection();
		let selected = "";
		if (selection && selection.trim()) {
			// The selection is what the user is pointing at, so it is budgeted before the note: up to half the result.
			const max = Math.floor(limit / 2);
			selected = `\n\n--- SELECTED TEXT ---\n${selection.length > max ? `${selection.slice(0, max)}\n[… selection cut at ${max} of ${selection.length} characters]` : selection}`;
		}
		const head = `# ${path}\n---\n`;
		const page = pageWithin(content, 0, limit, head.length + selected.length, (next) => `\n\n[TRUNCATED at character ${next} of ${content.length}. Use read_note with offset=${next} to read more.]`);
		return `${head}${page.text}${page.marker}${selected}`;
	},
};

export const createNote: ToolDefinition = {
	name: "create_note",
	description:
		"Create a new note. Fails if the note already exists. The user must approve the content before it is written.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Vault-relative path for the new note, e.g. 'Summaries/Chess Research.md'." },
			content: { type: "string", description: "Full markdown content of the note." },
		},
		required: ["path", "content"],
	},
	mutates: true,
	async execute(args, ctx) {
		const path = normalizeNotePath(str(args, "path"), ctx.configDir);
		const content = str(args, "content");
		if (ctx.vault.exists(path)) {
			throw new ToolError(`"${path}" already exists. Use edit_note, append_to_note or replace_note instead, or choose another path.`);
		}
		await requestApproval(ctx, { tool: "create_note", path, before: "", after: content, summary: `Create ${path}` });
		await ctx.vault.create(path, content);
		ctx.recordChange?.({ tool: "create_note", path, before: "", after: content });
		return `Created ${path} (${content.length} characters).`;
	},
};

export const editNote: ToolDefinition = {
	name: "edit_note",
	description:
		"Make a targeted edit to a note by replacing an exact passage with new text. old_text must match the note exactly and be unique unless replace_all is true: use the smallest unique passage (usually one line), not a whole section. Prefer this over replace_note for small changes; use edit_notes for many edits at once.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the note to edit." },
			old_text: { type: "string", description: "The exact text to replace." },
			new_text: { type: "string", description: "The replacement text. Use an empty string to delete the passage." },
			replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match (default false)." },
		},
		required: ["path", "old_text", "new_text"],
	},
	mutates: true,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const oldText = str(args, "old_text");
		const newText = typeof args.new_text === "string" ? args.new_text : str(args, "new_text", false);
		const replaceAll = bool(args, "replace_all");
		const before = await ctx.vault.read(path);
		const result = applyTextEdit(before, oldText, newText, replaceAll);
		if (!result.ok) {
			// A miss usually means the model worked from a search snippet or a paged read.
			// Show it the real lines so the retry is grounded instead of guessed.
			const hint = /not found/.test(result.error) ? nearestLines(before, oldText) : null;
			throw new ToolError(hint ? `${result.error}\n${hint}` : result.error);
		}
		if (result.content === before) return "The edit would not change anything; nothing written.";
		await requestApproval(ctx, {
			tool: "edit_note",
			path,
			before,
			after: result.content,
			summary: `Edit ${path} (${result.count} replacement${result.count === 1 ? "" : "s"})`,
		});
		await ctx.vault.modify(path, result.content);
		ctx.recordChange?.({ tool: "edit_note", path, before, after: result.content });
		return `Edited ${path}: ${result.count} replacement${result.count === 1 ? "" : "s"} applied.`;
	},
};

export const editNotes: ToolDefinition = {
	name: "edit_notes",
	description:
		"Apply many small edits in one call, possibly across many notes; edits to the same note are combined into one approval. Each edit is {path, new_text} plus EITHER old_text (exact unique passage) OR line_contains (text that identifies one line; add heading to limit the search to that section). new_text replaces the passage or the whole line; an empty new_text deletes it. Example: {\"path\":\"School/Lectures.md\",\"heading\":\"2026-09-02\",\"line_contains\":\"![[Recording 20260902\",\"new_text\":\"\"}. Use this for clean-ups found with grep_vault instead of one edit_note call per match. Failed edits are reported individually; the rest still apply.",
	parameters: {
		type: "object",
		properties: {
			edits: {
				type: "array",
				description: "The edits to apply, at most 40.",
				items: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path of the note." },
						old_text: { type: "string", description: "Exact text to replace (copy it from grep_vault / read_section). Omit when using line_contains." },
						line_contains: { type: "string", description: "Text that occurs in exactly one line (of the section, when heading is given); that whole line is replaced." },
						heading: { type: "string", description: "Optional heading text limiting line_contains to one section." },
						new_text: { type: "string", description: "Replacement; empty string deletes the passage or line." },
					},
					required: ["path", "new_text"],
				},
			},
		},
		required: ["edits"],
	},
	mutates: true,
	async execute(args, ctx) {
		const raw = args.edits;
		if (!Array.isArray(raw) || raw.length === 0) throw new ToolError("edits must be a non-empty array of {path, old_text, new_text}.");
		if (raw.length > 40) throw new ToolError("At most 40 edits per call; split the rest into another call.");
		// Group by resolved note, keeping the order of first appearance.
		const groups = new Map<string, { index: number; oldText: string; newText: string; lineContains?: string; heading?: string }[]>();
		const report: string[] = [];
		raw.forEach((e, index) => {
			const item = (e ?? {}) as Record<string, unknown>;
			const pathInput = typeof item.path === "string" ? item.path : "";
			const oldText = typeof item.old_text === "string" ? item.old_text : "";
			const lineContains = typeof item.line_contains === "string" && item.line_contains.trim() ? item.line_contains.trim() : undefined;
			const heading = typeof item.heading === "string" && item.heading.trim() ? item.heading.trim() : undefined;
			const newText = typeof item.new_text === "string" ? item.new_text : "";
			let path: string | null = null;
			try {
				path = pathInput ? resolveExisting(ctx.vault, pathInput) : null;
			} catch (err) {
				report.push(`#${index + 1} ${pathInput}: ${(err as Error).message}`);
				return;
			}
			if (!path) {
				report.push(`#${index + 1}: missing path.`);
				return;
			}
			if (!oldText && !lineContains) {
				report.push(`#${index + 1} ${path}: give old_text or line_contains.`);
				return;
			}
			const list = groups.get(path) ?? [];
			list.push({ index, oldText, newText, lineContains, heading });
			groups.set(path, list);
		});
		let applied = 0;
		for (const [path, edits] of groups) {
			const before = await ctx.vault.read(path);
			let content = before;
			const okIdx: number[] = [];
			for (const e of edits) {
				if (e.lineContains) {
					const r = replaceLine(content, e.lineContains, e.newText, e.heading);
					if (!r.ok) {
						report.push(`#${e.index + 1} ${path}: ${r.error}`);
						continue;
					}
					content = r.content;
					okIdx.push(e.index + 1);
					continue;
				}
				const result = applyTextEdit(content, e.oldText, e.newText, false);
				if (!result.ok) {
					const hint = /not found/.test(result.error) ? nearestLines(content, e.oldText) : "";
					report.push(`#${e.index + 1} ${path}: ${result.error}${hint ? `\n${hint}` : ""}`);
					continue;
				}
				content = result.content;
				okIdx.push(e.index + 1);
			}
			if (content === before) continue;
			try {
				await requestApproval(ctx, {
					tool: "edit_notes",
					path,
					before,
					after: content,
					summary: `Edit ${path} (${okIdx.length} change${okIdx.length === 1 ? "" : "s"})`,
				});
			} catch (err) {
				const message = (err as Error).message;
				report.push(`${path}: ${message}`);
				if (/^REJECTED/.test(message)) {
					report.push("Stopped: the user rejected a change. Do not retry it; ask what they want instead.");
					break;
				}
				if (/^Stopped/.test(message)) break;
				continue;
			}
			try {
				await ctx.vault.modify(path, content);
			} catch (err) {
				// Each note is written whole or not at all; a failed write leaves that note as it was.
				report.push(`${path}: the write failed (${(err as Error).message}); the note is unchanged.`);
				continue;
			}
			ctx.recordChange?.({ tool: "edit_note", path, before, after: content });
			applied += okIdx.length;
			report.push(`${path}: applied edit${okIdx.length === 1 ? "" : "s"} ${okIdx.map((i) => `#${i}`).join(", ")}.`);
		}
		return `${applied} of ${raw.length} edit${raw.length === 1 ? "" : "s"} applied.\n${report.join("\n")}`;
	},
};

/**
 * Replaces the one line containing `needle` (within `heading`'s section when given) with
 * `newText`; an empty replacement removes the line and a blank line that followed it.
 */
export function replaceLine(content: string, needle: string, newText: string, heading?: string): { ok: true; content: string } | { ok: false; error: string } {
	const lines = content.split("\n");
	let from = 0;
	let to = lines.length;
	if (heading) {
		const section = extractSection(content, heading);
		if (!section) return { ok: false, error: `no heading matching "${heading}".` };
		from = section.startLine - 1;
		to = section.endLine;
	}
	const lower = needle.toLowerCase();
	const hits: number[] = [];
	for (let i = from; i < to; i++) if (lines[i].toLowerCase().includes(lower)) hits.push(i);
	if (hits.length === 0) return { ok: false, error: `no line contains "${needle}"${heading ? ` under "${heading}"` : ""}.` };
	if (hits.length > 1) return { ok: false, error: `"${needle}" occurs on ${hits.length} lines${heading ? ` under "${heading}"` : ""} (${hits.map((i) => i + 1).join(", ")}); add heading or use a longer text.` };
	const i = hits[0];
	if (newText === "") {
		const removeBlank = i + 1 < lines.length && lines[i + 1].trim() === "" && (i === 0 || lines[i - 1].trim() === "");
		lines.splice(i, removeBlank ? 2 : 1);
	} else {
		lines.splice(i, 1, ...newText.split("\n"));
	}
	return { ok: true, content: lines.join("\n") };
}

export const appendToNote: ToolDefinition = {
	name: "append_to_note",
	description: "Append markdown to the end of an existing note. The user must approve before it is written.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the note to append to." },
			content: { type: "string", description: "Markdown to append." },
		},
		required: ["path", "content"],
	},
	mutates: true,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const content = str(args, "content");
		const before = await ctx.vault.read(path);
		const sep = before.length === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
		const after = before + sep + content.replace(/\s+$/, "") + "\n";
		await requestApproval(ctx, { tool: "append_to_note", path, before, after, summary: `Append to ${path}` });
		await ctx.vault.modify(path, after);
		ctx.recordChange?.({ tool: "append_to_note", path, before, after });
		return `Appended ${content.length} characters to ${path}.`;
	},
};

/** `content` with the body under `heading` replaced by `body` (the heading line stays). */
export function replaceSectionBody(content: string, heading: string, body: string): string | null {
	const section = extractSection(content, heading);
	if (!section) return null;
	const lines = content.split("\n");
	const start = section.startLine - 1;
	const headingLine = lines[start];
	const rest = lines.slice(section.endLine).join("\n");
	const trimmed = body.replace(/^\s*\n|\s+$/g, "");
	let text = trimmed ? `${headingLine}\n\n${trimmed}\n` : `${headingLine}\n`;
	if (rest.trim()) text += "\n";
	const head = start > 0 ? lines.slice(0, start).join("\n") + "\n" : "";
	return head + text + rest;
}

export const replaceSection: ToolDefinition = {
	name: "replace_section",
	description:
		"Replace everything under one heading of a note (up to the next heading of the same or a higher level) with new markdown; the heading line itself stays. The way to rewrite, empty or shorten a section without copying its old text: e.g. after compiling a daily note's inbox elsewhere, replace_section(path, 'Capture', '- Moved to [[Topics/X]]'). Heading matched case-insensitively, prefix is enough. The user must approve.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the note." },
			heading: { type: "string", description: "Heading text without the '#', e.g. 'Capture'." },
			new_text: { type: "string", description: "New body for the section; empty string empties it." },
		},
		required: ["path", "heading", "new_text"],
	},
	mutates: true,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const heading = str(args, "heading");
		const body = str(args, "new_text", false);
		const before = await ctx.vault.read(path);
		const after = replaceSectionBody(before, heading, body);
		if (after === null) {
			const available = ctx.vault.getMetadata(path).headings;
			throw new ToolError(`No heading matching "${heading}" in ${path}.${available.length ? ` Headings in this note:\n${available.join("\n")}` : " The note has no headings; use edit_note or replace_note."}`);
		}
		if (after === before) return `The section "${heading}" in ${path} already has that content; nothing written.`;
		await requestApproval(ctx, { tool: "replace_section", path, before, after, summary: `Replace section "${heading}" in ${path}` });
		await ctx.vault.modify(path, after);
		ctx.recordChange?.({ tool: "replace_section", path, before, after });
		return `Replaced the "${heading}" section of ${path} (${body.length} characters).`;
	},
};

export const replaceNote: ToolDefinition = {
	name: "replace_note",
	description:
		"Replace the entire contents of an existing note. Use this for reformatting or rewriting a whole note. Always read_note first. If the note has a YAML frontmatter block keep it unchanged; if it has none, do not add one. The user must approve before it is written.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the note to rewrite." },
			content: { type: "string", description: "The complete new markdown content." },
		},
		required: ["path", "content"],
	},
	mutates: true,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const content = str(args, "content");
		const before = await ctx.vault.read(path);
		if (content === before) return "The new content is identical to the current note; nothing written.";
		// Small models like to open a rewrite with "---" (a stray rule or invented frontmatter).
		if (!hasFrontmatter(before) && /^---[ \t]*\r?\n/.test(content)) {
			throw new ToolError(
				"The note has no YAML frontmatter, but the new content starts with '---'. Resubmit it without that leading line (if the user explicitly asked for frontmatter, add it with edit_note instead).",
			);
		}
		// Guard against a model that "rewrites" a long note into a stub.
		if (before.length > 400 && content.length < before.length * 0.3) {
			throw new ToolError(
				`The new content (${content.length} chars) is less than 30% of the current note (${before.length} chars). If you really mean to shorten it this much, say so to the user and ask them to confirm first; otherwise use edit_note for a targeted change.`,
			);
		}
		await requestApproval(ctx, { tool: "replace_note", path, before, after: content, summary: `Rewrite ${path}` });
		await ctx.vault.modify(path, content);
		ctx.recordChange?.({ tool: "replace_note", path, before, after: content });
		return `Rewrote ${path} (${before.length} → ${content.length} characters).`;
	},
};

export const findInNote: ToolDefinition = {
	name: "find_in_note",
	description:
		"Find the lines of a note that contain a text (case-insensitive) or a regular expression. Returns 1-based line numbers with one line of context. Use it to locate the exact passage for edit_note in a long note instead of reading the whole note, or to check whether a note mentions something.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the note to search." },
			pattern: { type: "string", description: "Text to look for, or a JavaScript regular expression when regex is true." },
			regex: { type: "boolean", description: "Treat pattern as a regular expression (default false)." },
			limit: { type: "integer", description: "Maximum matches to return (default 20, max 100)." },
		},
		required: ["path", "pattern"],
	},
	mutates: false,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const pattern = str(args, "pattern");
		const useRegex = bool(args, "regex");
		const limit = int(args, "limit", 20, 1, 100);
		const content = await ctx.vault.read(path);
		const lines = content.split("\n");
		/** Where in the line the match starts, or -1. */
		let find: (line: string) => number;
		let note = "";
		// Refused when it could freeze the app (see unsafeRegex); null when it is not a regular expression at all.
		const re = useRegex ? compileRegex(pattern) : null;
		if (re) find = regexFinder(re);
		else {
			// Small models mangle escapes in regexes; a literal search is more useful than an error.
			if (useRegex) note = `(The pattern is not a valid regular expression: ${tryRegexError(pattern)}. Searched for it as literal text instead.)\n`;
			const lower = pattern.toLowerCase();
			find = (line) => line.toLowerCase().indexOf(lower);
		}
		const hits: { line: number; at: number }[] = [];
		const started = performance.now();
		let searched = lines.length;
		for (let i = 0; i < lines.length; i++) {
			// A slow expression on a very long note: stop and say so, as grep_vault does.
			if (re && i % 200 === 199 && performance.now() - started > REGEX_BUDGET_MS) {
				searched = i;
				break;
			}
			const at = find(lines[i]);
			if (at >= 0) hits.push({ line: i, at });
		}
		if (searched < lines.length) note = `(This pattern is slow: the search was stopped after ${REGEX_BUDGET_MS / 1000} s at line ${searched} of ${lines.length}, so the result is incomplete. Use a simpler pattern.)\n${note}`;
		if (hits.length === 0) {
			return searched < lines.length ? `${note}No match in the lines searched so far.` : `${note}No lines in ${path} contain "${pattern}". The note has ${lines.length} lines (${content.length} characters).`;
		}
		const blocks = hits.slice(0, limit).map(({ line: i, at }) => {
			const rows: string[] = [];
			for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) {
				// A paragraph is one line: show the part around the match, and only the start of its neighbours.
				rows.push(`${j === i ? ">" : " "} ${String(j + 1).padStart(4)} | ${j === i ? clipLine(lines[j], FIND_LINE_CHARS, at) : clipLine(lines[j], FIND_CONTEXT_CHARS)}`);
			}
			return rows.join("\n");
		});
		const head = `${note}${hits.length} match${hits.length === 1 ? "" : "es"} in ${path} (${lines.length} lines). The matching line is marked with ">".\n`;
		const keep = Math.max(1, fitCount(blocks, ctx.maxResultChars - head.length - `\n…and ${hits.length} more matches.`.length, 5));
		const more = hits.length > keep ? `\n…and ${hits.length - keep} more matches.` : "";
		return `${head}${blocks.slice(0, keep).join("\n---\n")}${more}`;
	},
};

export const listFiles: ToolDefinition = {
	name: "list_files",
	description:
		"List the non-markdown files in the vault (attachments: audio and video recordings, images, PDFs, …), optionally filtered by folder, extension or a substring of the name. Newest first. Use it when the user talks about recordings, media or files rather than notes. read_file reads a PDF or text file; attachments cannot be edited.",
	parameters: {
		type: "object",
		properties: {
			folder: { type: "string", description: "Only files inside this folder (recursive). Omit for the whole vault; use '/' for the vault root only." },
			extension: { type: "string", description: "Only files with this extension, e.g. 'webm', 'm4a', 'pdf' (without the dot)." },
			name_contains: { type: "string", description: "Only files whose name contains this text (case-insensitive)." },
			limit: { type: "integer", description: "Maximum results (default 50, max 300)." },
		},
	},
	mutates: false,
	async execute(args, ctx) {
		const folder = str(args, "folder", false).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		const rootOnly = str(args, "folder", false).trim() === "/";
		const extension = str(args, "extension", false).replace(/^\./, "").toLowerCase();
		const nameContains = str(args, "name_contains", false).toLowerCase();
		const limit = int(args, "limit", 50, 1, 300);

		let files = ctx.vault.listAttachments();
		if (rootOnly) files = files.filter((f) => f.folder === "");
		else if (folder) {
			const prefix = folder.toLowerCase() + "/";
			files = files.filter((f) => f.path.toLowerCase().startsWith(prefix));
			const missing = files.length ? null : missingFolderHint(ctx.vault, folder);
			if (missing) throw new ToolError(missing);
		}
		if (extension) files = files.filter((f) => f.extension === extension);
		if (nameContains) files = files.filter((f) => f.basename.toLowerCase().includes(nameContains));
		files.sort((a, b) => b.mtime - a.mtime);
		const total = files.length;
		if (total === 0) return "No attachments matched those filters.";
		const rows = files.slice(0, limit).map((f) => `${f.path}  (${formatSize(f.size)}, modified ${localDate(f.mtime)})`);
		return listWithin(`${total} file${total === 1 ? "" : "s"}:\n`, rows, total, ctx.maxResultChars);
	},
};

export const deleteFile: ToolDefinition = {
	name: "delete_file",
	description:
		"Move a note or any other vault file (an attachment such as a recording, image or PDF) to the trash. Recoverable, never a permanent delete. The user must approve each deletion; if they reject it, do not try again — ask what they want instead.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Vault-relative path of the note or file to delete, e.g. 'Courses/CSCI578/2026-11-05.md' or 'Recordings/lecture.webm'." },
		},
		required: ["path"],
	},
	mutates: true,
	async execute(args, ctx) {
		const input = str(args, "path");
		const path = resolveAny(ctx.vault, input);
		if (!path) throw new ToolError(`No file found for "${input}". Use list_notes or list_files to find the exact path.`);
		const isNote = /\.md$/i.test(path);
		let before: string;
		let binary: ArrayBuffer | undefined;
		if (isNote) before = await ctx.vault.read(path);
		else {
			const info = ctx.vault.listAttachments().find((f) => f.path === path);
			before = `(attachment${info ? `, ${formatSize(info.size)}` : ""})`;
			// Keep a copy for undo unless it is huge.
			if (!info || info.size <= MAX_UNDO_BINARY_BYTES) {
				try {
					binary = await ctx.vault.readBinary(path);
				} catch {
					binary = undefined;
				}
			}
		}
		await requestApproval(ctx, { tool: "delete_file", path, before, after: "", summary: `Delete ${path} (move to trash)` });
		await ctx.vault.trash(path);
		ctx.recordChange?.({ tool: "delete_file", path, before, after: "", binary });
		return `Moved ${path} to the trash.`;
	},
};

export const moveNote: ToolDefinition = {
	name: "move_note",
	description:
		"Move or rename a note (or an attachment) to a new path. Wikilinks to it in other notes are updated automatically; missing folders are created. Use it to organise the vault. The user must approve first.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Current path of the note or file." },
			new_path: { type: "string", description: "New vault-relative path, e.g. 'Archive/2025/Old Project.md'. Keep the extension." },
		},
		required: ["path", "new_path"],
	},
	mutates: true,
	async execute(args, ctx) {
		const input = str(args, "path");
		const path = resolveAny(ctx.vault, input);
		if (!path) throw new ToolError(`No file found for "${input}". Use list_notes or list_files to find the exact path.`);
		const isNote = /\.md$/i.test(path);
		const newPath = isNote ? normalizeNotePath(str(args, "new_path"), ctx.configDir) : normalizeFilePath(str(args, "new_path"), ctx.configDir);
		if (newPath === path) return "The new path is the same as the current one; nothing moved.";
		if (ctx.vault.resolveFile(newPath) || ctx.vault.exists(newPath)) throw new ToolError(`"${newPath}" already exists. Choose another path.`);
		await requestApproval(ctx, { tool: "move_note", path, before: path, after: newPath, summary: `Move ${path} → ${newPath}` });
		await ctx.vault.rename(path, newPath);
		ctx.recordChange?.({ tool: "move_note", path: newPath, before: path, after: newPath });
		return `Moved ${path} to ${newPath}. Links in other notes were updated. The note now exists only at ${newPath}; the old path is gone, so do not read it to verify.`;
	},
};

function formatSize(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} kB`;
	return `${bytes} B`;
}

/**
 * For a failed edit_note: lines containing the most distinctive word of `oldText`, so the
 * model can copy the real text instead of guessing again.
 */
export function nearestLines(content: string, oldText: string): string {
	const lines = content.split("\n");
	const tokens = Array.from(new Set(oldText.split(/[^\p{L}\p{N}_.-]+/u).filter((t) => t.length >= 4))).sort(
		(a, b) => b.length - a.length,
	);
	for (const token of tokens.slice(0, 4)) {
		const lower = token.toLowerCase();
		const hits: number[] = [];
		for (let i = 0; i < lines.length && hits.length < 5; i++) {
			if (lines[i].toLowerCase().includes(lower)) hits.push(i);
		}
		if (hits.length > 0) {
			const rows = hits.map((i) => `${String(i + 1).padStart(4)} | ${lines[i]}`).join("\n");
			return `Lines in the note that contain "${token}" (copy old_text exactly from the note, or call find_in_note for more context):\n${rows}`;
		}
	}
	return `Nothing similar was found. The note has ${lines.length} lines (${content.length} characters); use find_in_note or read_note to locate the passage.`;
}


/** "YYYY-MM-DD" (or any Date-parsable string) → epoch ms at local midnight, or null. */
export function parseDate(s: string): number | null {
	const t = s.trim();
	if (!t) return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
	const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(t);
	const ms = d.getTime();
	return Number.isFinite(ms) ? ms : null;
}

export const readFile: ToolDefinition = {
	name: "read_file",
	description:
		"Read the text of an attachment: a PDF (text is extracted per page) or a plain-text file (.txt, .csv, .json, .html, …). Not for notes — use read_note. Long files are paged with offset.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the attachment, e.g. 'Attachments/slides.pdf'." },
			offset: { type: "integer", description: "Character offset to start from (default 0)." },
		},
		required: ["path"],
	},
	mutates: false,
	async execute(args, ctx) {
		const input = str(args, "path");
		const path = ctx.vault.resolveFile(input);
		if (!path) throw new ToolError(`No file found for "${input}". Use list_files to find the exact path.`);
		if (/\.md$/i.test(path)) throw new ToolError(`${path} is a note; use read_note.`);
		if (!ctx.readAttachmentText) throw new ToolError("Reading attachments is not available here.");
		const offset = int(args, "offset", 0, 0, 50_000_000);
		const text = await ctx.readAttachmentText(path);
		const scannable = !!ctx.describeImage && /\.pdf$/i.test(path);
		if (!text.replace(/^--- Page \d+ ---$/gm, "").trim()) return `${path} contains no extractable text (it may be a scanned image or a binary file).${scannable ? " Read its pages with read_image (path, page)." : ""}`;
		const head = `# ${path}\nlength: ${text.length} characters\n---\n`;
		let scanned = "";
		if (scannable && offset === 0) {
			const blank = Array.from(text.matchAll(/^--- Page (\d+) ---\n(?=\s*(?:--- Page|$))/gm), (m) => m[1]);
			if (blank.length) scanned = `\n\n[Page${blank.length === 1 ? "" : "s"} ${blank.slice(0, 20).join(", ")} ha${blank.length === 1 ? "s" : "ve"} no text layer (scanned). read_image with the path and page reads a scanned page.]`;
		}
		const page = pageWithin(
			text,
			offset,
			ctx.maxResultChars,
			head.length + scanned.length,
			(next) => `\n\n[TRUNCATED at character ${next} of ${text.length}. Call read_file again with offset=${next} to continue.]`,
		);
		return `${head}${page.text}${scanned}${page.marker}`;
	},
};

/**
 * A moment as the user's calendar has it: YYYY-MM-DD in local time. The UTC date is tomorrow's
 * every evening west of Greenwich, and it disagrees with modified_after / modified_before
 * (read as local midnight) and with daily note names.
 */
export function localDate(when: number | Date): string {
	const d = typeof when === "number" ? new Date(when) : when;
	const two = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export const ALL_TOOLS: ToolDefinition[] = [
	searchPassages,
	searchNotes,
	readNote,
	readSection,
	findInNote,
	grepVault,
	listSections,
	listNotes,
	listFiles,
	readFile,
	vaultOverview,
	getActiveNote,
	createNote,
	editNote,
	editNotes,
	appendToNote,
	replaceSection,
	replaceNote,
	moveNote,
	deleteFile,
];

export function toOllamaTools(tools: ToolDefinition[]): OllamaToolSpec[] {
	return tools.map((t) => ({
		type: "function",
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}));
}
