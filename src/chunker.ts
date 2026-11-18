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
			const pieces = para.length > max ? splitLong(para, max) : [para];
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

function splitLong(text: string, max: number): string[] {
	const out: string[] = [];
	const sentences = splitSentences(text);
	let current = "";
	for (const s of sentences) {
		if (s.length > max) {
			if (current) out.push(current);
			current = "";
			for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
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
