import { describe, expect, it } from "vitest";
import { StreamRenderer, commonPrefix, nextRenderDelay, splitStable, type BlockHost } from "../src/stream-blocks";

const lines = (...l: string[]) => l.join("\n");

describe("splitStable", () => {
	it("settles a paragraph once the next block has a complete first line", () => {
		expect(splitStable("First paragraph.\n\nSecond")).toEqual({ blocks: [], tail: "First paragraph.\n\nSecond" });
		expect(splitStable("First paragraph.\n\nSecond one.\n")).toEqual({ blocks: ["First paragraph."], tail: "Second one.\n" });
	});

	it("keeps the text when the blocks and the tail are put together again", () => {
		const text = lines("# Title", "", "Intro line", "continues.", "", "", "- a", "- b", "", "Closing.", "");
		const { blocks, tail } = splitStable(text);
		expect(blocks).toEqual(["# Title", "Intro line\ncontinues.", "- a\n- b"]);
		expect(tail).toBe("Closing.\n");
		expect([...blocks, tail].join("\n\n")).toBe(text.replace(/\n{3,}/g, "\n\n"));
	});

	it("never cuts inside a code fence, even at blank lines", () => {
		const text = lines("Before.", "", "```js", "const a = 1;", "", "const b = 2;", "```", "", "After.", "");
		expect(splitStable(text).blocks).toEqual(["Before.", "```js\nconst a = 1;\n\nconst b = 2;\n```"]);
	});

	it("does not take a shorter or different fence inside a code block for its end", () => {
		const text = lines("````md", "```", "", "still code", "~~~", "", "````", "", "After.", "");
		expect(splitStable(text).blocks).toEqual(["````md\n```\n\nstill code\n~~~\n\n````"]);
	});

	it("keeps an unclosed fence in the tail however long it gets", () => {
		const text = lines("Intro.", "", "```", "a", "", "b", "", "c", "");
		expect(splitStable(text)).toEqual({ blocks: ["Intro."], tail: "```\na\n\nb\n\nc\n" });
	});

	it("keeps a loose list in one block", () => {
		const text = lines("1. one", "", "2. two", "", "3. three", "", "Done.", "");
		expect(splitStable(text).blocks).toEqual(["1. one\n\n2. two\n\n3. three"]);
	});

	it("keeps indented continuations and nested items with their list item", () => {
		const text = lines("- item", "", "  more about the item", "", "    code under it", "", "- next", "", "Paragraph.", "");
		expect(splitStable(text).blocks).toEqual(["- item\n\n  more about the item\n\n    code under it\n\n- next"]);
	});

	it("cuts between a paragraph and the list that follows after a blank line", () => {
		const text = lines("Steps:", "", "- a", "- b", "", "Then:", "", "- c", "");
		expect(splitStable(text).blocks).toEqual(["Steps:", "- a\n- b", "Then:"]);
	});

	it("keeps a list that started right under a paragraph together with its later items", () => {
		const text = lines("Steps:", "- a", "", "- b", "", "End.", "");
		expect(splitStable(text).blocks).toEqual(["Steps:\n- a\n\n- b"]);
	});

	it("does not cut inside display maths or an Obsidian comment", () => {
		const maths = lines("Before.", "", "$$", "a = b", "", "c = d", "$$", "", "After.", "");
		expect(splitStable(maths).blocks).toEqual(["Before.", "$$\na = b\n\nc = d\n$$"]);
		const inline = lines("So $$x^2$$ holds.", "", "Next.", "", "End.", "");
		expect(splitStable(inline).blocks).toEqual(["So $$x^2$$ holds.", "Next."]);
		const comment = lines("Before.", "", "%%", "hidden", "", "more", "%%", "", "After.", "");
		expect(splitStable(comment).blocks).toEqual(["Before.", "%%\nhidden\n\nmore\n%%"]);
	});

	it("settles nothing once a link or footnote definition appears", () => {
		const text = lines("See [the docs][d] and a note[^1].", "", "More text.", "", "[d]: https://example.com", "", "[^1]: The footnote.", "");
		expect(splitStable(text)).toEqual({ blocks: [], tail: text });
		// A task list item or a link at the start of a line is not a definition.
		expect(splitStable(lines("[a link](x) starts this line", "", "- [ ] task", "", "End.", "")).blocks.length).toBe(2);
	});

	it("stops cutting after raw HTML, which can wrap the blocks below it", () => {
		const text = lines("Intro.", "", "<details>", "", "Inside one.", "", "Inside two.", "", "</details>", "", "After.", "");
		const { blocks, tail } = splitStable(text);
		expect(blocks).toEqual(["Intro."]);
		expect(tail.startsWith("<details>")).toBe(true);
		// An autolink at the start of a line is not HTML.
		expect(splitStable(lines("<https://example.com> is the page.", "", "Next.", "", "End.", "")).blocks).toEqual(["<https://example.com> is the page.", "Next."]);
	});

	it("cuts tables, headings, quotes and rules apart", () => {
		const text = lines("## Heading", "", "| a | b |", "| - | - |", "| 1 | 2 |", "", "> quoted", "> more", "", "---", "", "End.", "");
		expect(splitStable(text).blocks).toEqual(["## Heading", "| a | b |\n| - | - |\n| 1 | 2 |", "> quoted\n> more", "---"]);
	});

	it("handles Windows line endings and leading blank lines", () => {
		expect(splitStable("\n\nOne.\r\n\r\nTwo.\r\n\r\nThree.\r\n")).toEqual({ blocks: ["\n\nOne.\r", "Two.\r"], tail: "Three.\r\n" });
	});

	it("only ever adds blocks as the text grows (no definitions or HTML)", () => {
		const text = lines(
			"# Notes on sensors",
			"",
			"Hall sensors are **cheap** and `robust`.",
			"",
			"1. First point",
			"",
			"   with a continuation",
			"",
			"2. Second point",
			"",
			"```py",
			"def f():",
			"",
			"    return 1",
			"```",
			"",
			"| a | b |",
			"| - | - |",
			"",
			"$$",
			"x",
			"",
			"y",
			"$$",
			"",
			"> quote",
			"",
			"- x",
			"- y",
			"",
			"Last paragraph.",
			"",
		);
		let previous: string[] = [];
		for (let n = 0; n <= text.length; n++) {
			const { blocks, tail } = splitStable(text.slice(0, n));
			expect(blocks.slice(0, previous.length)).toEqual(previous);
			// Nothing is lost or repeated: blocks and tail are the text, give or take blank lines.
			expect([...blocks, tail].join("\n\n").replace(/\n{2,}/g, "\n\n")).toBe(text.slice(0, n).replace(/\n{2,}/g, "\n\n"));
			previous = blocks;
		}
		expect(previous.length).toBe(8);
	});
});

describe("commonPrefix and nextRenderDelay", () => {
	it("counts the leading items that are the same", () => {
		expect(commonPrefix([1, 2, 3], [1, 2, 4], (a, b) => a === b)).toBe(2);
		expect(commonPrefix([1, 2], [1, 2, 3], (a, b) => a === b)).toBe(2);
		expect(commonPrefix([], [1], (a, b) => a === b)).toBe(0);
	});

	it("waits at least the base delay and four times the last render, up to a cap", () => {
		expect(nextRenderDelay(0)).toBe(120);
		expect(nextRenderDelay(10)).toBe(120);
		expect(nextRenderDelay(60)).toBe(240);
		expect(nextRenderDelay(5000)).toBe(1500);
		expect(nextRenderDelay(Number.NaN)).toBe(120);
	});
});

/** A node of the fake screen: one rendered top-level piece of markdown. */
interface FakeNode {
	id: number;
	text: string;
}

/**
 * A screen without a DOM. "Rendering" cuts the markdown at blank lines outside code fences, one node
 * per piece, which is enough to check the renderer's bookkeeping: what is on screen, in which order,
 * what was rendered and what was left alone.
 */
class FakeHost implements BlockHost<FakeNode> {
	screen: FakeNode[] = [];
	removed: FakeNode[] = [];
	private nextId = 1;

	static pieces(markdown: string): string[] {
		const out: string[] = [];
		let current: string[] = [];
		let fenced = false;
		for (const line of markdown.split("\n")) {
			if (/^\s*```/.test(line)) fenced = !fenced;
			if (!fenced && line.trim() === "") {
				if (current.length) out.push(current.join("\n"));
				current = [];
			} else current.push(line);
		}
		if (current.length) out.push(current.join("\n"));
		return out;
	}

	async render(markdown: string): Promise<FakeNode[]> {
		return FakeHost.pieces(markdown).map((text) => ({ id: this.nextId++, text }));
	}
	append(nodes: FakeNode[]): void {
		this.screen.push(...nodes);
	}
	remove(nodes: FakeNode[]): void {
		for (const n of nodes) {
			const at = this.screen.indexOf(n);
			if (at < 0) throw new Error(`removed a node that is not on screen: ${n.text}`);
			this.screen.splice(at, 1);
			this.removed.push(n);
		}
	}
	same(a: FakeNode, b: FakeNode): boolean {
		return a.text === b.text;
	}
	text(): string[] {
		return this.screen.map((n) => n.text);
	}
}

const ANSWER = lines(
	"## Summary",
	"",
	"Hall sensors are cheap. They are also robust.",
	"",
	"- one",
	"- two",
	"",
	"```js",
	"const a = 1;",
	"",
	"const b = 2;",
	"```",
	"",
	"The last paragraph ends the answer.",
);

async function stream(host: FakeHost, text: string, step: number): Promise<StreamRenderer<FakeNode>> {
	const r = new StreamRenderer(host);
	for (let n = step; n < text.length; n += step) {
		await r.update(text.slice(0, n));
		// At every moment the screen shows exactly the text so far.
		expect(host.text()).toEqual(FakeHost.pieces(text.slice(0, n)));
	}
	return r;
}

describe("StreamRenderer", () => {
	it("shows the text so far after every update, whatever the size of the pieces", async () => {
		for (const step of [1, 3, 7, 40, 500]) {
			const host = new FakeHost();
			const r = await stream(host, ANSWER, step);
			await r.finish(ANSWER);
			expect(host.text()).toEqual(FakeHost.pieces(ANSWER));
		}
	});

	it("renders a settled block once and leaves its node alone", async () => {
		const host = new FakeHost();
		const r = new StreamRenderer(host);
		await r.update("First paragraph.\n\nSecond paragraph is being wri");
		const first = host.screen[0];
		await r.update("First paragraph.\n\nSecond paragraph is being written.\n\nThird");
		await r.update("First paragraph.\n\nSecond paragraph is being written.\n\nThird one now.\n\nFourth");
		expect(host.screen[0]).toBe(first);
		expect(host.removed).not.toContain(first);
		// The second paragraph was on screen as part of the tail when it settled: it stays too.
		const second = host.screen[1];
		await r.update("First paragraph.\n\nSecond paragraph is being written.\n\nThird one now.\n\nFourth one.\n\nFifth");
		expect(host.screen[1]).toBe(second);
		expect(host.text()).toEqual(["First paragraph.", "Second paragraph is being written.", "Third one now.", "Fourth one.", "Fifth"]);
	});

	it("hands the renderer far fewer characters than rendering everything each time", async () => {
		const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} says something about the vault and goes on for a while to be of ordinary length.`);
		const text = paragraphs.join("\n\n");
		const host = new FakeHost();
		const r = new StreamRenderer(host);
		let whole = 0;
		for (let n = 25; n < text.length; n += 25) {
			await r.update(text.slice(0, n));
			whole += n;
		}
		expect(host.text()).toEqual(FakeHost.pieces(text.slice(0, text.length - (text.length % 25 || 25))));
		// Each paragraph is rendered a few times while it is the tail and once when it settles.
		expect(r.stats.chars).toBeLessThan(whole / 10);
	});

	it("does not render again when nothing changed", async () => {
		const host = new FakeHost();
		const r = new StreamRenderer(host);
		await r.update("One.\n\nTwo");
		const renders = r.stats.renders;
		await r.update("One.\n\nTwo");
		expect(r.stats.renders).toBe(renders);
	});

	it("keeps the nodes that already match when the finished answer differs at the end", async () => {
		const host = new FakeHost();
		const r = new StreamRenderer(host);
		const streamed = "The plan is in `Ideas/Plan.md`.\n\nIt has three steps.\n\nThat is all";
		await r.update(streamed);
		const [first, second] = host.screen;
		// The agent appends a sources line and completes the last sentence.
		await r.finish("The plan is in `Ideas/Plan.md`.\n\nIt has three steps.\n\nThat is all.\n\nSources: [[Ideas/Plan]]");
		expect(host.screen[0]).toBe(first);
		expect(host.screen[1]).toBe(second);
		expect(host.text()).toEqual(["The plan is in `Ideas/Plan.md`.", "It has three steps.", "That is all.", "Sources: [[Ideas/Plan]]"]);
	});

	it("replaces everything from the first node that differs in the finished answer", async () => {
		const host = new FakeHost();
		const r = new StreamRenderer(host);
		await r.update("See `Ideas/Plan.md`.\n\nIt has three steps.\n\nEnd");
		const second = host.screen[1];
		await r.finish("See [[Ideas/Plan]].\n\nIt has three steps.\n\nEnd.");
		expect(host.text()).toEqual(["See [[Ideas/Plan]].", "It has three steps.", "End."]);
		// Order on screen is what counts: the unchanged second paragraph was after a changed one, so it was drawn again.
		expect(host.screen[1]).not.toBe(second);
	});

	it("takes settled blocks back when a definition arrives, without redrawing what still looks the same", async () => {
		const host = new FakeHost();
		const r = new StreamRenderer(host);
		await r.update("First [ref][d].\n\nSecond.\n\nThird");
		expect(host.text()).toEqual(["First [ref][d].", "Second.", "Third"]);
		const first = host.screen[0];
		const text = "First [ref][d].\n\nSecond.\n\nThird.\n\n[d]: https://example.com\n";
		await r.update(text);
		expect(host.text()).toEqual(FakeHost.pieces(text));
		expect(host.screen[0]).toBe(first);
		await r.finish(text);
		expect(host.text()).toEqual(FakeHost.pieces(text));
	});

	it("shows nothing for an empty answer and can finish without any update", async () => {
		const host = new FakeHost();
		const r = new StreamRenderer(host);
		await r.update("");
		await r.update("  \n");
		expect(host.screen).toEqual([]);
		expect(r.stats.renders).toBe(0);
		await r.finish("Done.");
		expect(host.text()).toEqual(["Done."]);
	});
});
