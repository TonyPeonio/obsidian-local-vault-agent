import { browser, expect } from "@wdio/globals";
import { splitStable } from "../../src/stream-blocks";

/**
 * The claim the streaming renderer rests on, checked against Obsidian's own markdown renderer: a
 * block that `splitStable` calls settled renders on its own exactly as it renders inside the whole
 * text. For every prefix of a document that ends at a line end, the settled blocks rendered one by
 * one, followed by the rest, must give the same DOM as the prefix rendered in one piece.
 */

const lines = (...l: string[]) => l.join("\n");

/** Ordinary answer markdown, with the constructs that span blank lines. */
const DOCUMENT = lines(
	"# Notes on the robot",
	"",
	"The drive uses **hall sensors** and a `PID` loop; see [[Ideas/Plan]] and the [vendor page](https://example.com).",
	"A second line of the same paragraph.",
	"",
	"## Steps",
	"",
	"1. Mount the sensor.",
	"",
	"   It sits two millimetres from the magnet.",
	"",
	"   - a nested point",
	"   - another one",
	"",
	"2. Calibrate it.",
	"",
	"3. Log the readings.",
	"",
	"Tight list right under a paragraph:",
	"- first",
	"- second",
	"",
	"- third, after a blank line",
	"",
	"| Part | Cost | Owner |",
	"| --- | ---: | --- |",
	"| Sensor | 0.80 | Ana |",
	"| Magnet | 0.20 | Ben |",
	"",
	"> A quotation that runs",
	"> over two lines.",
	"",
	"> A second quotation.",
	"",
	"> [!note] A callout",
	"> With a body.",
	"",
	"```ts",
	"const reading = sensor.read();",
	"",
	"if (reading > threshold) stop();",
	"```",
	"",
	"~~~",
	"plain fence with ``` inside",
	"",
	"still code",
	"~~~",
	"",
	"- [ ] an open task",
	"- [x] a done task",
	"",
	"---",
	"",
	"Text with ==highlight==, *emphasis*, ~~strike~~ and a line that ends the first part.",
	"",
	"    an indented code block",
	"    of two lines",
	"",
	"Display maths:",
	"",
	"$$",
	"a^2 + b^2",
	"",
	"= c^2",
	"$$",
	"",
	"And inline $$x^2$$ maths in a sentence, then a comment:",
	"",
	"%%",
	"hidden from the reader",
	"",
	"on two paragraphs",
	"%%",
	"",
	"The last paragraph.",
	"",
);

/** Raw HTML that wraps the blocks below it, and definitions that change the blocks above them. */
const AWKWARD = lines(
	"Intro paragraph with a footnote[^1] and a [reference link][ref].",
	"",
	"<details>",
	"<summary>More</summary>",
	"",
	"Hidden paragraph one.",
	"",
	"Hidden paragraph two.",
	"",
	"</details>",
	"",
	"After the details.",
	"",
	"[ref]: https://example.com",
	"",
	"[^1]: The footnote text.",
	"",
	"Closing paragraph.",
	"",
);

/** Every prefix that ends at a line end, cut into what the streaming renderer would render separately. */
function cases(text: string): { prefix: string; pieces: string[] }[] {
	const out: { prefix: string; pieces: string[] }[] = [];
	for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
		const prefix = text.slice(0, at + 1);
		const { blocks, tail } = splitStable(prefix);
		// Only prefixes where something is settled say anything: without a cut, the two renders are the same call.
		if (blocks.length > 0) out.push({ prefix, pieces: [...blocks, tail] });
	}
	return out;
}

async function compare(text: string): Promise<{ checked: number; mismatches: { prefixEnd: string; pieces: number; got: string; want: string }[] }> {
	const all = cases(text);
	const mismatches = await browser.executeObsidian(async ({ app, obsidian }, all) => {
		const view = app.workspace.getLeavesOfType("local-vault-agent-view")[0].view;
		const render = async (markdown: string): Promise<HTMLElement> => {
			const el = document.createElement("div");
			if (markdown.trim()) await obsidian.MarkdownRenderer.render(app, markdown, el, "", view);
			return el;
		};
		// Structure, text and attributes (ids and data attributes aside: they may differ between two
		// renders of the same text). Obsidian puts a line break between two blocks of one render;
		// between blocks it is not text anyone sees, and the chat leaves it out, so it is left out here too.
		const attributes = (el: Element) =>
			Array.from(el.attributes)
				.filter((a) => a.name !== "id" && a.name !== "dir" && !a.name.startsWith("data-") && !a.name.startsWith("aria-"))
				.map((a) => ` ${a.name}="${a.value}"`)
				.sort()
				.join("");
		const outline = (el: Element, top = true): string =>
			`<${el.tagName.toLowerCase()}${top ? "" : attributes(el)}>${Array.from(el.childNodes)
				.map((n) => (n.nodeType === 1 ? outline(n as Element, false) : n.nodeType === 3 && !(top && !(n.textContent ?? "").trim()) ? (n.textContent ?? "") : ""))
				.join("")}</>`;
		const bad: { prefixEnd: string; pieces: number; got: string; want: string }[] = [];
		for (const c of all) {
			const whole = outline(await render(c.prefix));
			const joined = document.createElement("div");
			for (const piece of c.pieces) joined.append(...Array.from((await render(piece)).childNodes));
			const got = outline(joined);
			if (got !== whole) {
				let i = 0;
				while (i < got.length && got[i] === whole[i]) i++;
				bad.push({ prefixEnd: c.prefix.slice(-60), pieces: c.pieces.length, got: got.slice(Math.max(0, i - 80), i + 160), want: whole.slice(Math.max(0, i - 80), i + 160) });
			}
		}
		return bad;
	}, all);
	return { checked: all.length, mismatches };
}

describe("Blocks of a streamed reply, against Obsidian's renderer", function () {
	before(async function () {
		await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins["local-vault-agent"] as { settings: Record<string, unknown>; saveSettings(): Promise<void> };
			Object.assign(plugin.settings, { setupShown: true, survey: "done", semanticSearch: false });
			await plugin.saveSettings();
		});
		await browser.executeObsidianCommand("local-vault-agent:open-chat");
		await browser.$(".lva-input").waitForExist({ timeout: 20000 });
	});

	it("renders every settled block on its own as it renders inside the whole text", async function () {
		const result = await compare(DOCUMENT);
		console.log(`blocks check: ${result.checked} prefixes of the ordinary document, ${result.mismatches.length} mismatches`);
		expect(result.checked).toBeGreaterThan(40);
		expect(result.mismatches).toEqual([]);
	});

	it("settles nothing that raw HTML wraps or a definition changes", async function () {
		const result = await compare(AWKWARD);
		console.log(`blocks check: ${result.checked} prefixes of the awkward document, ${result.mismatches.length} mismatches`);
		expect(result.mismatches).toEqual([]);
	});
});
