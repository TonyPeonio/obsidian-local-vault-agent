import { splitSentences } from "./chunker";

/**
 * Paragraph-level citations: which paragraph of a note an answer used, and a link to exactly that
 * paragraph. A paragraph that already has a block id (`^id`) is linked as `[[note#^id]]`; one that
 * has none gets a proposed id, which is only written to the note when the user approves the diff
 * (one diff per note, all of that answer's ids at once). Until then, or when the user says no, the
 * link points at the paragraph's heading, which needs no write. Lecture Companion transcript
 * paragraphs (`**[m:ss]** …`) get ids derived from their time (`^t12-05`), so the link reads like
 * the timestamp it stands for. Pure: no Obsidian, no I/O.
 */

export type CitationMode = "off" | "headings" | "blocks";

export interface Paragraph {
	/** First and last line (0-based, inclusive) of the paragraph in the note. */
	start: number;
	end: number;
	/** The paragraph's text without its block id. */
	text: string;
	/** The nearest heading above it (text only, no #), or null. */
	heading: string | null;
	blockId: string | null;
	/** `m:ss` when the paragraph is a transcript paragraph starting with `**[m:ss]**`. */
	timestamp: string | null;
}

const BLOCK_ID = /\s\^([A-Za-z0-9-]+)\s*$/;
const TIMESTAMP_START = /^\s*(?:\*\*)?\[(\d{1,2}:\d{2}(?::\d{2})?)\](?:\*\*)?/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** The note's paragraphs: runs of text lines, each list item on its own; headings, code, tables and frontmatter are not paragraphs. */
export function paragraphs(content: string): Paragraph[] {
	const lines = content.split("\n");
	const out: Paragraph[] = [];
	let heading: string | null = null;
	let i = 0;
	if (/^---\r?$/.test(lines[0] ?? "")) {
		const close = lines.findIndex((l, j) => j > 0 && /^---\r?$/.test(l));
		if (close > 0) i = close + 1;
	}
	let fence: string | null = null;
	let cur: { start: number; lines: string[] } | null = null;
	const flush = (end: number) => {
		if (!cur) return;
		const raw = cur.lines.join("\n").replace(/\r/g, "");
		const id = BLOCK_ID.exec(cur.lines[cur.lines.length - 1].replace(/\r$/, ""));
		const text = id ? raw.replace(BLOCK_ID, "").trimEnd() : raw.trimEnd();
		if (text.trim()) out.push({ start: cur.start, end, text, heading, blockId: id ? id[1] : null, timestamp: TIMESTAMP_START.exec(text)?.[1] ?? null });
		cur = null;
	};
	for (; i < lines.length; i++) {
		const line = lines[i].replace(/\r$/, "");
		const f = /^\s*(```|~~~)/.exec(line);
		if (fence) {
			if (f && f[1] === fence) fence = null;
			continue;
		}
		if (f) {
			flush(i - 1);
			fence = f[1];
			continue;
		}
		const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (h) {
			flush(i - 1);
			heading = h[2].trim();
			continue;
		}
		if (!line.trim() || /^\s*\|/.test(line) || /^\s*\^[A-Za-z0-9-]+\s*$/.test(line)) {
			flush(i - 1);
			continue;
		}
		if (cur && (LIST_ITEM.test(line) || TIMESTAMP_START.test(line))) flush(i - 1);
		if (!cur) cur = { start: i, lines: [] };
		cur.lines.push(line);
	}
	flush(lines.length - 1);
	return out;
}

/** Markdown emphasis, quote marks and blockquote markers removed, whitespace collapsed, lower case. */
export function plainText(s: string): string {
	return s
		.replace(/^\s*>\s?/gm, "")
		.replace(/\*\*|__|[*_`"“”]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** The answer's quoted spans of 20+ and sentences of 30+ characters, in the same plain form, for matching against note text. */
export function quotable(answer: string): string[] {
	const out: string[] = [];
	for (const m of answer.matchAll(/["“]([^"”\n]{20,})["”]/g)) out.push(plainText(m[1]));
	for (const line of answer.split("\n")) {
		const plain = plainText(line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ""));
		for (const sentence of splitSentences(plain)) if (sentence.length >= 30) out.push(sentence);
	}
	return out;
}

/** `m:ss` / `h:mm:ss` → seconds, or null. */
export function timestampSeconds(raw: string): number | null {
	const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
	if (!m) return null;
	return m[3] === undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function contentWords(text: string): Set<string> {
	return new Set((plainText(text).match(/[\p{L}\p{N}]{5,}/gu) ?? []).filter((w) => !/^\d+$/.test(w)));
}

/**
 * The paragraphs of a note the answer used, in note order, at most `max`: those it quotes word for
 * word (a quoted span or a sentence of 30+ characters), those whose `[m:ss]` it names, and those
 * that share most of the content words of one of its sentences (a paraphrase).
 */
export function matchPassages(answer: string, content: string, max = 3): Paragraph[] {
	const paras = paragraphs(content).filter((p) => p.text.length >= 20);
	if (paras.length === 0 || !answer.trim()) return [];
	const plains = paras.map((p) => plainText(p.text));
	const chosen = new Set<number>();
	// Word-for-word quotes.
	for (const f of quotable(answer)) {
		const i = plains.findIndex((p) => p.includes(f));
		if (i >= 0) chosen.add(i);
	}
	// Timestamps named in the answer, against transcript paragraphs.
	const stamps = new Set<number>();
	for (const m of answer.matchAll(/(^|[^\d:])(\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])/g)) {
		const s = timestampSeconds(m[2]);
		if (s !== null) stamps.add(s);
	}
	if (stamps.size) {
		paras.forEach((p, i) => {
			const s = p.timestamp ? timestampSeconds(p.timestamp) : null;
			if (s !== null && stamps.has(s)) chosen.add(i);
		});
	}
	// Paraphrases: one paragraph per answer sentence, when it has most of that sentence's words.
	if (chosen.size === 0) {
		const paraWords = paras.map((p) => contentWords(p.text));
		for (const line of answer.split("\n")) {
			for (const sentence of splitSentences(line)) {
				const words = contentWords(sentence);
				if (words.size < 4) continue;
				let best = -1;
				let bestShared = 0;
				paraWords.forEach((pw, i) => {
					let shared = 0;
					for (const w of words) if (pw.has(w)) shared++;
					if (shared > bestShared) {
						bestShared = shared;
						best = i;
					}
				});
				if (best >= 0 && bestShared >= 4 && bestShared / words.size >= 0.6) chosen.add(best);
			}
		}
	}
	return Array.from(chosen)
		.sort((a, b) => a - b)
		.slice(0, max)
		.map((i) => paras[i]);
}

/** Every block id already used in the note. */
export function blockIds(content: string): Set<string> {
	const out = new Set<string>();
	for (const m of content.matchAll(/(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*\r?$/gm)) out.add(m[1]);
	return out;
}

/** A short deterministic hash of text in base 36. */
function shortHash(text: string): string {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h.toString(36).padStart(6, "0").slice(0, 6);
}

/** A new block id for `p` that `taken` does not have: `t12-05` for a transcript paragraph at 12:05, else `c` plus a hash of its text. */
export function newBlockId(p: Paragraph, taken: Set<string>): string {
	const base = p.timestamp ? `t${p.timestamp.replace(/:/g, "-")}` : `c${shortHash(p.text)}`;
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	taken.add(id);
	return id;
}

/** `content` with ` ^id` appended to the last line of each paragraph (line endings kept). */
export function addBlockIds(content: string, items: { end: number; id: string }[]): string {
	const lines = content.split("\n");
	for (const { end, id } of items) {
		if (end < 0 || end >= lines.length) continue;
		const cr = lines[end].endsWith("\r") ? "\r" : "";
		lines[end] = `${lines[end].replace(/\r$/, "").trimEnd()} ^${id}${cr}`;
	}
	return lines.join("\n");
}

/** Heading text as a link subpath: Obsidian links cannot carry `#`, `|`, `^`, `[` or `]`. */
function headingSubpath(h: string): string {
	return h.replace(/[#|^[\]]/g, " ").replace(/\s+/g, " ").trim();
}

/** The wikilink to one paragraph: by block id when there is one, else by its heading. */
export function passageLink(path: string, p: Paragraph, id: string | null): string {
	const target = path.replace(/\.md$/i, "");
	const name = target.split("/").pop() ?? target;
	const where = p.timestamp ?? (p.heading ? headingSubpath(p.heading) : "");
	const alias = where ? `${name} › ${where}` : name;
	if (id) return `[[${target}#^${id}|${alias}]]`;
	if (p.heading && headingSubpath(p.heading)) return `[[${target}#${headingSubpath(p.heading)}|${alias}]]`;
	return `[[${target}|${alias}]]`;
}

export interface Citation {
	path: string;
	paragraph: Paragraph;
	/** The id to link: the paragraph's own, or a proposed one when it has none. */
	id: string;
	/** True when the id is proposed and still has to be written to the note. */
	isNew: boolean;
}

/** Paragraph citations for an answer over the notes it cites (at most `perNote` per note, 6 in all). */
export function planCitations(answer: string, notes: { path: string; content: string }[], perNote = 3): Citation[] {
	const out: Citation[] = [];
	for (const note of notes) {
		const taken = blockIds(note.content);
		for (const p of matchPassages(answer, note.content, perNote)) {
			if (out.length >= 6) return out;
			if (p.blockId) out.push({ path: note.path, paragraph: p, id: p.blockId, isNew: false });
			else out.push({ path: note.path, paragraph: p, id: newBlockId(p, taken), isNew: true });
		}
	}
	return out;
}

/** Per note, the content with the proposed block ids written in (notes that need none are left out). */
export function blockIdEdits(citations: Citation[], contents: Map<string, string>): Map<string, string> {
	const out = new Map<string, string>();
	const byNote = new Map<string, Citation[]>();
	for (const c of citations) if (c.isNew) byNote.set(c.path, [...(byNote.get(c.path) ?? []), c]);
	for (const [path, cites] of byNote) {
		const before = contents.get(path);
		if (before === undefined) continue;
		out.set(path, addBlockIds(before, cites.map((c) => ({ end: c.paragraph.end, id: c.id }))));
	}
	return out;
}

/**
 * The answer with a "Passages:" line linking each cited paragraph. `written` holds the notes whose
 * proposed ids were written; a proposed id in any other note falls back to the heading link.
 */
export function withPassages(answer: string, citations: Citation[], written: Set<string>): string {
	if (citations.length === 0) return answer;
	const links = citations.map((c) => passageLink(c.path, c.paragraph, !c.isNew || written.has(c.path) ? c.id : null));
	const unique = Array.from(new Set(links));
	return `${answer.trimEnd()}\n\nPassages: ${unique.join(", ")}`;
}

/** Notes an answer links to (wikilink targets, without subpaths), in order, deduplicated. */
export function linkedTargets(answer: string): string[] {
	const out: string[] = [];
	const prose = answer.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
	for (const m of prose.matchAll(/(!?)\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
		if (m[1] === "!") continue;
		const t = m[2].trim();
		if (t && !out.includes(t)) out.push(t);
	}
	return out;
}
