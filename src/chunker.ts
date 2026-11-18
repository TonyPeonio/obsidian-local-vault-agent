/**
 * Splits a markdown note into embedding-sized chunks along heading and paragraph
 * boundaries. Pure function so it is unit-tested directly.
 */

export interface Chunk {
	/** The heading the text sits directly under ("" before the first heading). */
	heading: string;
	/**
	 * The heading with the headings above it, joined by " › " ("2026-09-10 › Summary"). A note
	 * that repeats a heading under each date or topic has many sections called "Summary"; the
	 * path is what tells them apart. The note's single top-level title is left out: it says what
	 * the note's name already says.
	 */
	crumb: string;
	text: string;
}

/** Joins the headings above a section into the path shown to the model and embedded with the text. */
export const CRUMB_SEPARATOR = " › ";

export interface ChunkOptions {
	/** Target chunk size in characters (≈ 4 chars per token). */
	target?: number;
	/** Hard maximum; a single paragraph longer than this is split on sentence boundaries. */
	max?: number;
}

const DEFAULTS: Required<ChunkOptions> = { target: 1400, max: 2200 };

export function stripFrontmatter(content: string): { frontmatter: string; body: string } {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { frontmatter: "", body: content };
	return { frontmatter: m[1], body: content.slice(m[0].length) };
}

/**
 * The text of a note that `chunkMarkdown` puts in no chunk's text: its properties and its heading
 * lines. A heading lives on only as the path of the text under it, so one with nothing under it is
 * in no chunk at all, and neither is a lone top-level title that has only sections below it. The
 * word index keeps these words apart, so that "no note contains this word" is about whole notes.
 */
export function unchunkedText(content: string): string {
	const { frontmatter, body } = stripFrontmatter(content);
	const headings = body.split(/\r?\n/).filter((line) => /^#{1,6}\s/.test(line));
	return [frontmatter, ...headings].filter(Boolean).join("\n");
}

export function chunkMarkdown(content: string, opts: ChunkOptions = {}): Chunk[] {
	const { target, max } = { ...DEFAULTS, ...opts };
	const { body } = stripFrontmatter(content);
	const lines = body.split(/\r?\n/);

	// 1. Split into sections by heading.
	const sections: { heading: string; crumb: string; lines: string[] }[] = [{ heading: "", crumb: "", lines: [] }];
	let inFence = false;
	/** The headings the current line is nested under, outermost first. */
	const stack: { level: number; text: string }[] = [];
	let h1Count = 0;
	let firstH1 = "";
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const h = !inFence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (h) {
			const level = h[1].length;
			if (level === 1 && h1Count++ === 0) firstH1 = h[2].trim();
			while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
			stack.push({ level, text: h[2].trim() });
			sections.push({ heading: h[2].trim(), crumb: stack.map((s) => s.text).join(CRUMB_SEPARATOR), lines: [] });
		} else {
			sections[sections.length - 1].lines.push(line);
		}
	}
	// A single `# Title` at the top is the note's name again: drop it from the paths below it.
	if (h1Count === 1) {
		const prefix = firstH1 + CRUMB_SEPARATOR;
		for (const s of sections) if (s.crumb.startsWith(prefix)) s.crumb = s.crumb.slice(prefix.length);
	}

	// 2. Within a section, pack paragraphs up to `target`, splitting long ones at `max`.
	const chunks: Chunk[] = [];
	for (const section of sections) {
		const text = section.lines.join("\n").trim();
		if (!text) continue;
		const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
		let current = "";
		const flush = () => {
			if (current.trim()) chunks.push({ heading: section.heading, crumb: section.crumb, text: current.trim() });
			current = "";
		};
		for (const para of paragraphs) {
			const pieces = para.length > max ? (splitTable(para, max) ?? splitLong(para, max)) : [para];
			for (const piece of pieces) {
				if (current && current.length + piece.length + 2 > target) flush();
				current = current ? `${current}\n\n${piece}` : piece;
			}
		}
		flush();
	}
	return chunks;
}

/** Split on sentence-ending punctuation followed by whitespace (no lookbehind: older iOS lacks it). */
export function splitSentences(text: string): string[] {
	const out: string[] = [];
	let start = 0;
	const re = /[.!?]+\s+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		out.push(text.slice(start, m.index + m[0].length).trimEnd());
		start = m.index + m[0].length;
	}
	if (start < text.length) out.push(text.slice(start));
	return out.filter((s) => s.length > 0);
}

/** The line under a table's heading row: `|---|:--:|`, with or without the outer bars. */
const TABLE_RULE = /^(?:\s*>)*\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$|^(?:\s*>)*\s*\|\s*:?-+:?\s*\|\s*$/;

/** Where a table in these lines begins, looking from line `from` on: the index of its heading row, or -1. A table inside a callout or a quote (`> | a | b |`) is one too. */
export function tableStart(lines: string[], from = 0): number {
	for (let i = Math.max(1, from + 1); i < lines.length; i++) if (TABLE_RULE.test(lines[i]) && lines[i - 1].includes("|")) return i - 1;
	return -1;
}

/**
 * A paragraph that holds a table and is too long for one chunk, cut between its lines, each piece
 * of a table under that table's heading row again. A table has no sentences, so `splitLong` cut it
 * every `max` characters: in the middle of a row, and every piece after the first was rows of
 * values with no column names. A heading row, its rule and the first row stay together; a second
 * table in the same paragraph is cut under its own heading row; text before or between the tables
 * is cut between its lines. Null when the paragraph has no table.
 */
function splitTable(para: string, max: number): string[] | null {
	const lines = para.split("\n");
	if (tableStart(lines) < 0) return null;
	const out: string[] = [];
	let current: string[] = [];
	let size = 0;
	/** The heading row and rule of the table the line is in, and how many of its rows the piece has. */
	let head: string[] | null = null;
	let rows = 0;
	const push = () => {
		if (current.length) out.push(current.join("\n"));
		current = [];
		size = 0;
		rows = 0;
	};
	const add = (...more: string[]) => {
		for (const line of more) {
			current.push(line);
			size += line.length + 1;
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i + 1 < lines.length && line.includes("|") && TABLE_RULE.test(lines[i + 1])) {
			head = [line, lines[i + 1]];
			const first = lines[i + 2]?.includes("|") ? lines[i + 2].length + 1 : 0;
			if (current.length && size + line.length + lines[i + 1].length + 2 + first > max) push();
			add(...head);
			rows = 0;
			i++;
			continue;
		}
		if (head && !line.includes("|")) head = null;
		// The first row stays under its heading row whatever its length.
		if (current.length && size + line.length + 1 > max && !(head && rows === 0)) {
			push();
			if (head) add(...head);
		}
		add(line);
		if (head) rows++;
	}
	push();
	// A single line longer than a chunk (a very long row, a long sentence before the table) is cut as any long text is.
	return out.flatMap((piece) => (piece.length > max ? splitLong(piece, max) : [piece]));
}

/**
 * Cuts a text that has no sentence end and is longer than a chunk (a long list without full stops,
 * a long line of code, a list of links) into pieces of at most `max` characters, between words:
 * after the last line that ends in the second half of the piece when there is one, otherwise at
 * the last whitespace. It used to be cut every `max` characters, through the middle of a word, and
 * a word cut inside its first four letters that stood nowhere else was then "in no note" for the
 * word index. Only a stretch with no whitespace at all (one endless token, a script written
 * without spaces) is still cut every `max` characters, and then never between the two halves of
 * one character.
 */
function cutLong(text: string, max: number): string[] {
	const out: string[] = [];
	let start = 0;
	while (text.length - start > max) {
		// One character more than a piece holds: whitespace right after a full piece is a place to cut too.
		const reach = text.slice(start, start + max + 1);
		let cut = reach.lastIndexOf("\n");
		if (cut < max / 2) {
			cut = max;
			while (cut > 0 && !/\s/.test(reach[cut])) cut--;
		}
		if (cut > 0) {
			out.push(reach.slice(0, cut).trimEnd());
			start += cut + 1;
			while (start < text.length && /\s/.test(text[start])) start++;
			continue;
		}
		const code = reach.charCodeAt(max - 1);
		cut = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
		out.push(reach.slice(0, cut));
		start += cut;
	}
	if (start < text.length) out.push(text.slice(start));
	return out.filter((piece) => piece.length > 0);
}

function splitLong(text: string, max: number): string[] {
	const out: string[] = [];
	const sentences = splitSentences(text);
	let current = "";
	for (const s of sentences) {
		if (s.length > max) {
			if (current) out.push(current);
			current = "";
			out.push(...cutLong(s, max));
			continue;
		}
		if (current && current.length + s.length + 1 > max) {
			out.push(current);
			current = s;
		} else {
			current = current ? `${current} ${s}` : s;
		}
	}
	if (current) out.push(current);
	return out;
}
