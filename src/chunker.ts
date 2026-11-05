/**
 * Splits a markdown note into embedding-sized chunks along heading and paragraph
 * boundaries. Pure function so it is unit-tested directly.
 */

export interface Chunk {
	heading: string;
	text: string;
}

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

export function chunkMarkdown(content: string, opts: ChunkOptions = {}): Chunk[] {
	const { target, max } = { ...DEFAULTS, ...opts };
	const { body } = stripFrontmatter(content);
	const lines = body.split(/\r?\n/);

	// 1. Split into sections by heading.
	const sections: { heading: string; lines: string[] }[] = [{ heading: "", lines: [] }];
	let inFence = false;
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const h = !inFence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (h) {
			sections.push({ heading: h[2].trim(), lines: [] });
		} else {
			sections[sections.length - 1].lines.push(line);
		}
	}

	// 2. Within a section, pack paragraphs up to `target`, splitting long ones at `max`.
	const chunks: Chunk[] = [];
	for (const section of sections) {
		const text = section.lines.join("\n").trim();
		if (!text) continue;
		const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
		let current = "";
		const flush = () => {
			if (current.trim()) chunks.push({ heading: section.heading, text: current.trim() });
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
