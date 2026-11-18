import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { chunkMarkdown, splitSentences, type Chunk } from "../src/chunker";

/**
 * Review of 62c3ecb (a stretch longer than a chunk with no sentence end is cut between words):
 * ordinary notes must be cut exactly as the benchmarked chunker (commit 853380e) cut them, because
 * the chunks are what the model is handed as passages.
 *
 * The corpus below was chunked with the chunker of 853380e and the result pinned as a hash. When
 * that chunker is on disk (`git show 853380e:src/chunker.ts > .e2e/chunker-853380e.ts`, a folder
 * git ignores) the two are also compared directly, on the corpus and on every note of the test
 * vaults.
 */

const sentence = (i: number) => `Sentence number ${i} says something about the gantry, the belt and the pulley.`;
const words = (n: number, w = "alpha") => Array.from({ length: n }, (_, i) => `${w}${i % 7}`).join(" ");

/** Twenty ordinary notes: every paragraph fits one chunk or has sentence ends that are close enough together. */
function corpus(): Record<string, string> {
	const longList = Array.from({ length: 120 }, (_, i) => `- Item ${i}: tighten the belt and check the pulley.`).join("\n");
	const tableRows = Array.from({ length: 60 }, (_, i) => `| M-${100 + i} | NEMA ${[14, 17, 23][i % 3]} | ${(0.4 + i * 0.05).toFixed(2)} A | ${12 + (i % 4) * 4} N·cm |`).join("\n");
	return {
		"01 one short paragraph": "The gantry carries an electromagnet over the chessboard.",
		"02 three paragraphs": "First paragraph, one line.\n\nSecond paragraph.\nIt has two lines.\n\nThird paragraph ends here.",
		"03 a paragraph just under a chunk": words(310),
		"04 a long paragraph of sentences": Array.from({ length: 220 }, (_, i) => sentence(i)).join(" "),
		"05 a long paragraph with questions and exclamations": Array.from({ length: 150 }, (_, i) => `${sentence(i)} Why ${i}? Because! `).join("").trim(),
		"06 a bulleted list": Array.from({ length: 12 }, (_, i) => `- part M-${i} stepper motor, NEMA 17`).join("\n"),
		"07 a numbered list": Array.from({ length: 30 }, (_, i) => `${i + 1}. Check the belt on axis ${i}`).join("\n"),
		"08 a task list": "- [ ] order the GT3 belts\n- [x] measure the pulley\n    - [ ] nested: ask Marcus\n- [ ] book the room",
		"09 a long list whose lines end in full stops": longList,
		"10 a long numbered list without full stops": Array.from({ length: 200 }, (_, i) => `${i + 1}. tighten bolt ${i} on the frame`).join("\n"),
		"11 a code block": "Some code:\n\n```python\ndef home(axis):\n    while not switch(axis):\n        step(axis, -1)\n    return 0\n```\n\nIt homes on two limit switches.",
		"12 a code block with blank lines and a heading-like comment": "```bash\n# not a heading\nnpm run build\n\n# still not a heading\nnpm test\n```",
		"13 a long code block with blank lines": "```ts\n" + Array.from({ length: 80 }, (_, i) => `export function f${i}(x: number): number {\n\treturn x * ${i};\n}\n`).join("\n") + "```",
		"14 headings nested three deep": "# Robot club\n\nIntro line.\n\n## 2026-09-10\n\n### Summary\n\nWe met.\n\n### Done\n\n- wired the harness\n\n## 2026-09-17\n\n### Summary\n\nWe met again.",
		"15 properties and a title": "---\nstatus: active\nowner: Sam\ntags: [robot, club]\n---\n# Bike Computer\n\nGPS logging works.\n\n## Next\n\nOrder the display.",
		"16 a small table": "| Part | Frame |\n|---|---|\n| M-100 | NEMA 14 |\n| M-101 | NEMA 17 |",
		"17 a table longer than a chunk": `# Motors\n\nMeasured in October.\n\n| Part | Frame | Rated current | Holding torque |\n|---|---|---|---|\n${tableRows}\n\nThe quotes are in the shared folder.`,
		"18 a callout and a quotation": "> [!note] Belt tension\n> About 3.5 kg measured with a luggage scale.\n\n> A quotation of two lines.\n> Second line.",
		"19 many medium paragraphs under one heading": "## Minutes\n\n" + Array.from({ length: 14 }, (_, i) => `${sentence(i)} ${words(60, "word")}. ${sentence(i + 100)}`).join("\n\n"),
		"20 Windows line ends and links": "# Links\r\n\r\nSee [[Projects/Chess Robot]] and [the site](https://example.com/a.b?c=d).\r\n\r\n- [[Clubs/Robot club log 2026]]\r\n- https://example.com/gt2-belt-tension\r\n",
	};
}

/** The pieces of every note, as text: what a hash or a comparison is made of. */
function cut(chunk: (content: string) => Chunk[], notes: Record<string, string>): string {
	return JSON.stringify(Object.entries(notes).map(([name, content]) => [name, chunk(content).map((c) => [c.heading, c.crumb, c.text])]));
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** sha256 of `cut(chunkMarkdown of 853380e, corpus())`. */
const PINNED = "7d153c9f9e6d5657ef59a46adbc3f9f5e7e0c5a053e0fa28febcb107832dae8d";

const OLD_CHUNKER = resolve(".e2e/chunker-853380e.ts");

function notesOf(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			if (name.startsWith(".")) continue;
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (name.endsWith(".md")) out[p] = readFileSync(p, "utf8");
		}
	};
	if (existsSync(dir)) walk(dir);
	return out;
}

describe("ordinary notes are cut exactly as the benchmarked chunker cut them", () => {
	it("the corpus is ordinary: twenty notes, and no stretch between sentence ends is longer than a chunk", () => {
		const notes = corpus();
		expect(Object.keys(notes)).toHaveLength(20);
		// More than one piece comes out of several of them, so the comparison is not of whole notes only.
		expect(Object.values(notes).filter((n) => chunkMarkdown(n).length > 1).length).toBeGreaterThanOrEqual(8);
		expect(notes["03 a paragraph just under a chunk"].length).toBeGreaterThan(2100);
		for (const [name, content] of Object.entries(notes)) {
			for (const para of content.split(/\r?\n\s*\r?\n/)) {
				// A table is cut between its rows by another rule, which 62c3ecb did not touch.
				if (para.includes("|---")) continue;
				for (const s of splitSentences(para)) expect(s.length, name).toBeLessThanOrEqual(2200);
			}
		}
	});

	it("twenty ordinary paragraphs, lists, code blocks and tables: the same pieces as at 853380e", () => {
		expect(sha(cut(chunkMarkdown, corpus()))).toBe(PINNED);
	});

	it.skipIf(!existsSync(OLD_CHUNKER))("compared directly with the chunker of 853380e, on the corpus and on every note of the test vaults", async () => {
		const old = (await import(/* @vite-ignore */ pathToFileURL(OLD_CHUNKER).href)) as { chunkMarkdown: typeof chunkMarkdown };
		expect(sha(cut(old.chunkMarkdown, corpus()))).toBe(PINNED);
		expect(cut(chunkMarkdown, corpus())).toBe(cut(old.chunkMarkdown, corpus()));
		for (const dir of ["test-vault", "test-vault-large"]) {
			const notes = notesOf(dir);
			for (const [path, content] of Object.entries(notes)) {
				expect(cut(chunkMarkdown, { [path]: content }), path).toBe(cut(old.chunkMarkdown, { [path]: content }));
			}
		}
		// And the old chunker is the old one: it cut the fix's own case through a word.
		const line = "alpha ".repeat(400).slice(0, 2197) + " zeppelin " + "omega ".repeat(120).trim();
		expect(old.chunkMarkdown(line).some((c) => /\bzeppelin\b/.test(c.text))).toBe(false);
		expect(chunkMarkdown(line).some((c) => /\bzeppelin\b/.test(c.text))).toBe(true);
	});
});

describe("what 62c3ecb does change, exactly", () => {
	it("in a paragraph that has sentence ends, only a stretch longer than a chunk between two of them is cut differently", () => {
		const before = Array.from({ length: 20 }, (_, i) => sentence(i)).join(" ");
		const stretch = "alpha ".repeat(400).slice(0, 2197) + " zeppelin " + "omega ".repeat(120).trim() + ".";
		const after = Array.from({ length: 20 }, (_, i) => sentence(i + 50)).join(" ");
		expect(before.length).toBeLessThan(2200);
		expect(before.length).toBeGreaterThan(1400);
		const pieces = chunkMarkdown(`${before} ${stretch} ${after}`).map((c) => c.text);
		// The sentences before and after the stretch are packed as they always were.
		expect(pieces[0]).toBe(before);
		expect(pieces[pieces.length - 1]).toBe(after);
		// The stretch itself: whole words, none lost, none twice.
		const middle = pieces.slice(1, -1);
		expect(middle.length).toBeGreaterThan(1);
		expect(middle.join(" ").split(/\s+/)).toEqual(stretch.split(/\s+/));
		for (const p of middle) expect(p.length).toBeLessThanOrEqual(2200);
	});
});
