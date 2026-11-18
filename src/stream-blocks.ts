/**
 * Drawing an answer while it is being written, without drawing all of it again on every update.
 *
 * The text that has arrived is cut into blocks that markdown renders the same on their own as in
 * the whole (paragraphs, headings, a whole list, a whole code block, …). A block that is complete
 * is rendered once and then left alone, so the reader can select text in it; only the part still
 * being written (the "tail") is rendered again, and of that only the nodes that changed are
 * replaced. When the answer is finished it is rendered once as a whole and, again, only what
 * differs from what is on screen is replaced.
 *
 * Pure: no DOM and no Obsidian. The view supplies a `BlockHost` that renders and places nodes.
 */

const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
/** A link or footnote definition: it changes how blocks above it render, so nothing is settled once one appears. */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:(?:\s|$)/;
/** The start of raw HTML, which can wrap the blocks that follow it (`<details>` … `</details>`). Autolinks (`<https://…>`) are not HTML. */
const HTML_START = /^ {0,3}<(?![a-z][a-z0-9+.-]*:)(?![^\s<>@]+@)[a-z!?/]/i;

function countOf(line: string, token: string): number {
	let n = 0;
	for (let i = line.indexOf(token); i >= 0; i = line.indexOf(token, i + token.length)) n++;
	return n;
}

export interface SplitResult {
	/** Complete blocks, in order; each renders on its own as it would inside the whole text. */
	blocks: string[];
	/** The rest: the block still being written. Empty when the text ends exactly at a block. */
	tail: string;
}

/**
 * Cuts markdown that is still arriving into settled blocks and the tail. A cut is made only at a
 * blank line, outside code fences, `$$` maths and `%%` comments, when the next complete line starts
 * at the left margin and does not continue a list. Whether a cut is made depends only on complete
 * lines, so the blocks of a text are a prefix of the blocks of any longer text — except that a
 * link/footnote definition or raw HTML further down takes blocks back (see `StreamRenderer`).
 */
export function splitStable(text: string): SplitResult {
	const lines = text.split("\n");
	// The last piece has no newline after it yet: it is still being written and decides nothing.
	const complete = lines.length - 1;
	const blocks: string[] = [];
	let fence: { char: string; length: number } | null = null;
	let math = false;
	let comment = false;
	/** Index of the first line of the block being collected. */
	let blockStart = 0;
	/** Index of the first blank line after the block's last content line, when a cut there is still possible. */
	let gapAt = -1;
	let blockHasContent = false;
	let blockHasList = false;
	/** Raw HTML was opened in the current block: nothing after it is cut off. */
	let frozen = false;

	for (let i = 0; i < complete; i++) {
		const line = lines[i];
		if (fence) {
			const m = FENCE.exec(line);
			if (m && m[1][0] === fence.char && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
			continue;
		}
		const blank = line.trim() === "";
		if (!math && !comment) {
			if (blank) {
				if (blockHasContent && gapAt < 0) gapAt = i;
				continue;
			}
			if (DEFINITION.test(line)) return { blocks: [], tail: text };
			if (gapAt >= 0 && !frozen) {
				const indented = /^[ \t]/.test(line);
				const continuesList = blockHasList && LIST_ITEM.test(line);
				if (!indented && !continuesList) {
					blocks.push(lines.slice(blockStart, gapAt).join("\n"));
					blockStart = i;
					blockHasList = false;
				}
			}
			gapAt = -1;
			blockHasContent = true;
			if (HTML_START.test(line)) frozen = true;
			if (LIST_ITEM.test(line.trimStart())) blockHasList = true;
			const f = FENCE.exec(line);
			if (f) {
				fence = { char: f[1][0], length: f[1].length };
				continue;
			}
		}
		if (blank) continue;
		// `$$` and `%%` open and close on any line; an odd number of them on one line changes the state.
		if (!comment && countOf(line, "$$") % 2 === 1) math = !math;
		else if (!math && countOf(line, "%%") % 2 === 1) comment = !comment;
	}
	return { blocks, tail: lines.slice(blockStart).join("\n") };
}

/** How many leading items of `a` and `b` are the same. */
export function commonPrefix<A, B>(a: readonly A[], b: readonly B[], same: (x: A, y: B) => boolean): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && same(a[i], b[i])) i++;
	return i;
}

/**
 * How long to wait before the next render: at least `base`, and long enough that rendering takes
 * no more than one part in `1 + factor` of the time, however slow the last render was.
 */
export function nextRenderDelay(lastRenderMs: number, base = 120, max = 1500, factor = 4): number {
	if (!Number.isFinite(lastRenderMs) || lastRenderMs <= 0) return base;
	return Math.min(max, Math.max(base, Math.round(lastRenderMs * factor)));
}

/** What the view does for the renderer: turn markdown into nodes, and place or remove them at the end of the answer. */
export interface BlockHost<N> {
	/** Renders markdown and returns its top-level nodes, not yet placed. */
	render(markdown: string): Promise<N[]>;
	/** Adds nodes after everything placed so far. */
	append(nodes: N[]): void;
	remove(nodes: N[]): void;
	/** Whether two rendered nodes look the same (so the one on screen can stay). */
	same(a: N, b: N): boolean;
}

export interface RenderStats {
	/** Calls to `host.render`. */
	renders: number;
	/** Characters of markdown handed to `host.render` in total. */
	chars: number;
	/** Nodes taken off the screen and put back because they changed. */
	replaced: number;
}

interface Rendered<N> {
	source: string;
	nodes: N[];
}

/**
 * Keeps what is on screen in step with the text so far. `update` and `finish` must not overlap:
 * the caller awaits one before starting the next (the chat's renderer runs them one after another).
 * Everything is rendered first and placed afterwards in one go, so the screen never shows a gap.
 */
export class StreamRenderer<N> {
	private settled: Rendered<N>[] = [];
	private tail: Rendered<N> = { source: "", nodes: [] };
	readonly stats: RenderStats = { renders: 0, chars: 0, replaced: 0 };

	constructor(private host: BlockHost<N>) {}

	private async render(markdown: string): Promise<N[]> {
		if (!markdown.trim()) return [];
		this.stats.renders++;
		this.stats.chars += markdown.length;
		return this.host.render(markdown);
	}

	/**
	 * Shows `fresh` after everything placed before it. The leading nodes of `onScreen` that already
	 * look the same stay where they are (a selection in them survives); from the first difference on,
	 * what is on screen is replaced. Returns the nodes that now show `fresh`, and what is left on
	 * screen after them.
	 */
	private place(fresh: N[], onScreen: N[]): { shown: N[]; rest: N[] } {
		const keep = commonPrefix(onScreen, fresh, (a, b) => this.host.same(a, b));
		if (keep === fresh.length) return { shown: onScreen.slice(0, keep), rest: onScreen.slice(keep) };
		const stale = onScreen.slice(keep);
		if (stale.length) {
			this.stats.replaced += stale.length;
			this.host.remove(stale);
		}
		this.host.append(fresh.slice(keep));
		return { shown: [...onScreen.slice(0, keep), ...fresh.slice(keep)], rest: [] };
	}

	/** Draws the text that has arrived so far: blocks that are complete once, then the part still being written. */
	async update(text: string): Promise<void> {
		const { blocks, tail } = splitStable(text);
		const keep = commonPrefix(this.settled, blocks, (r, source) => r.source === source);
		if (keep === this.settled.length && keep === blocks.length && tail === this.tail.source) return;
		const freshBlocks: N[][] = [];
		for (let i = keep; i < blocks.length; i++) freshBlocks.push(await this.render(blocks[i]));
		const freshTail = await this.render(tail);

		// Blocks after `keep` were taken back (a definition or raw HTML arrived further down); their
		// nodes and the old tail's are what is on screen after the blocks that stay.
		let pending = [...this.settled.splice(keep).flatMap((r) => r.nodes), ...this.tail.nodes];
		for (let i = 0; i < freshBlocks.length; i++) {
			const placed = this.place(freshBlocks[i], pending);
			pending = placed.rest;
			this.settled.push({ source: blocks[keep + i], nodes: placed.shown });
		}
		const placed = this.place(freshTail, pending);
		if (placed.rest.length) {
			this.stats.replaced += placed.rest.length;
			this.host.remove(placed.rest);
		}
		this.tail = { source: tail, nodes: placed.shown };
	}

	/**
	 * Draws the finished answer. It is rendered once as a whole (so it is exactly what a plain
	 * render gives), and the nodes on screen that already match stay where they are.
	 */
	async finish(text: string): Promise<void> {
		const fresh = await this.render(text);
		const placed = this.place(fresh, [...this.settled.flatMap((r) => r.nodes), ...this.tail.nodes]);
		if (placed.rest.length) {
			this.stats.replaced += placed.rest.length;
			this.host.remove(placed.rest);
		}
		this.settled = [{ source: text, nodes: placed.shown }];
		this.tail = { source: "", nodes: [] };
	}
}
