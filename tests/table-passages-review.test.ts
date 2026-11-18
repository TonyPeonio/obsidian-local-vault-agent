import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/chunker";
import { clipPassage, searchPassages, tableRowsFor } from "../src/tools";
import type { ToolContext } from "../src/types";
import { FakeVault } from "./fakes";

/**
 * The review's own tables: no passage may end inside a row or hold rows without their heading
 * row, and a passage cut to fit says so.
 */

const head = "| Part | Frame | Rated current | Holding torque | Notes |\n|---|---|---|---|---|";
const row = (i: number, note = "") => `| P-${100 + i} | size ${[14, 17, 23][i % 3]} | ${(0.4 + i * 0.05).toFixed(2)} A | ${12 + (i % 4) * 4} N·cm | ${note} |`;
const table = (n: number, noteAt = -1) => `${head}\n${Array.from({ length: n }, (_, i) => row(i, i === noteAt ? "drives the conveyor" : "")).join("\n")}`;
const long = table(300);
const names = `| Name | Value |\n|:--|--:|\n${Array.from({ length: 200 }, (_, i) => `| name ${i} | ${i * 7} |`).join("\n")}`;
const wideHead = `| ${Array.from({ length: 14 }, (_, k) => `Column number ${k} with a long name`).join(" | ")} |\n|${"---|".repeat(14)}`;
const wide = `${wideHead}\n${Array.from({ length: 40 }, (_, i) => `| ${Array.from({ length: 14 }, (_, k) => `value ${i}.${k} of this wide table cell`).join(" | ")} |`).join("\n")}`;
const inCallout = (text: string) => `> [!note] Parts\n> ${text.split("\n").join("\n> ")}`;

const isRule = (line: string | undefined) => line !== undefined && /-/.test(line) && /^[\s>|:-]+$/.test(line);

/** Chunks the note and counts what must not happen: a line with a bar that is not a whole line of the note, a first row not under a heading row and its rule, a chunk over the maximum. */
function check(note: string) {
	const original = new Set(note.split("\n").map((l) => l.trim()));
	const chunks = chunkMarkdown(note);
	let partRows = 0;
	let withoutHead = 0;
	let tooLong = 0;
	let rows = 0;
	for (const c of chunks) {
		const lines = c.text.split("\n");
		for (const l of lines) {
			if (!l.includes("|")) continue;
			rows++;
			if (!original.has(l.trim())) partRows++;
		}
		const first = lines.findIndex((l) => l.includes("|"));
		if (first >= 0 && !isRule(lines[first + 1])) withoutHead++;
		if (c.text.length > 2200) tooLong++;
	}
	return { chunks: chunks.length, partRows, withoutHead, tooLong, rows };
}

describe("tables cut into chunks", () => {
	const cases: Record<string, string> = {
		"a table of 300 rows": long,
		"a wide table (14 columns, rows of 450 characters)": wide,
		"a table directly under a heading": `# Parts\n## Motors\n${long}`,
		"two tables in a note": `# Parts\n\n${long}\n\nSome text between.\n\n${names}`,
		"two tables in one paragraph": `${long}\nA line between the two tables.\n${names}`,
		"a table inside a callout": inCallout(long),
		"rows with empty cells": `${head}\n${Array.from({ length: 300 }, (_, i) => (i % 5 === 0 ? `| P-${i} | | | | |` : row(i))).join("\n")}`,
		"escaped bars in cells": `| Part | Note |\n|---|---|\n${Array.from({ length: 200 }, (_, i) => `| P-${i} | [[Motors/P-${i}\\|datasheet ${i}]] and \`a \\| b\` |`).join("\n")}`,
		"a table indented under a list item": `- item\n  ${long.split("\n").join("\n  ")}`,
		"a long line of text before the table": `${"An opening sentence before the table. ".repeat(70)}\n${long}`,
	};

	it.each(Object.keys(cases))("%s: every row whole, every piece under its heading row, no piece too long", (name) => {
		const result = check(cases[name]);
		expect(result.chunks).toBeGreaterThan(1);
		expect({ partRows: result.partRows, withoutHead: result.withoutHead, tooLong: result.tooLong }).toEqual({ partRows: 0, withoutHead: 0, tooLong: 0 });
	});

	it("puts the second table's later rows under the second table's heading row, not the first's", () => {
		const chunks = chunkMarkdown(`${long}\nA line between the two tables.\n${names}`);
		for (const c of chunks.filter((x) => x.text.includes("| name 199 |"))) {
			expect(c.text.startsWith("| Name | Value |\n|:--|--:|\n")).toBe(true);
			expect(c.text).not.toContain("| Part |");
		}
	});

	it("keeps every row of the note in some chunk", () => {
		for (const note of [long, inCallout(long), `${long}\nA line between the two tables.\n${names}`]) {
			const all = chunkMarkdown(note).map((c) => c.text).join("\n");
			for (const line of note.split("\n")) expect(all).toContain(line.trim());
		}
	});

	it("known and left as it is: a single row longer than a chunk is cut inside the row", () => {
		const note = `${head}\n${row(0)}\n| P-x | ${"very long cell text ".repeat(150)} | 1 A | 2 N·cm | |\n${Array.from({ length: 60 }, (_, i) => row(i + 1)).join("\n")}`;
		const result = check(note);
		expect(result.partRows).toBeGreaterThan(0);
		expect(result.tooLong).toBe(0);
	});
});

describe("a table passage cut to fit the tool result", () => {
	const lastShown = (clipped: string) => clipped.split("\n").slice(0, -1);

	it("ends on a whole row and says it was cut, for a wide table and a table in a callout", () => {
		for (const [text, cap] of [
			[wide, 600],
			[wide, 1000],
			[wide, 1500],
			[inCallout(table(36)), 700],
			[table(36), 250],
		] as const) {
			const clipped = clipPassage(text, cap);
			expect(clipped.endsWith("\n[… section truncated; read_section for the rest]")).toBe(true);
			const original = new Set(text.split("\n"));
			for (const l of lastShown(clipped)) expect(original.has(l), `${cap}: ${l.slice(0, 60)}`).toBe(true);
			// The heading row is the first thing shown.
			expect(clipped.startsWith(text.split("\n")[0])).toBe(true);
		}
	});

	it("ends on a whole cell when not even the heading row fits, and says it was cut", () => {
		const clipped = clipPassage(wide, 200);
		const shown = lastShown(clipped).join("\n");
		expect(shown.length).toBeLessThanOrEqual(200);
		expect(shown.endsWith("|")).toBe(true);
		expect(wide.startsWith(shown)).toBe(true);
		expect(clipped).toContain("section truncated");
	});

	it("keeps the whole result within the limit when two wide tables share it", async () => {
		const ctx = { vault: new FakeVault({}), maxResultChars: 2000, search: async () => [], approve: async () => "approve" } as unknown as ToolContext;
		ctx.searchPassages = async () => [
			{ path: "A.md", heading: "A", text: wide, score: 0.7 },
			{ path: "B.md", heading: "B", text: wide, score: 0.6 },
		];
		const out = await searchPassages.execute({ query: "value 7.3 of this wide table" }, ctx);
		expect(out.length).toBeLessThanOrEqual(2000);
		expect(out).toContain("section truncated");
	});
});

describe("the row stated under a table passage", () => {
	const machines = `| Machine | Driven by | Belt |\n|---|---|---|\n${Array.from({ length: 8 }, (_, i) => `| machine ${i} | P-${100 + i} | ${i === 3 ? "conveyor belt GT2" : "none"} |`).join("\n")}`;
	const QUESTION = "what is the holding torque of the part that drives the conveyor?";

	it("is found in a table inside a callout", () => {
		expect(tableRowsFor(inCallout(table(36, 22)), "which part drives the conveyor?")).toBe(
			"\n[The row of this table with the question's words, each value after its column heading:\n- Part: P-122; Frame: size 17; Rated current: 1.50 A; Holding torque: 20 N·cm; Notes: drives the conveyor]",
		);
	});

	it("says which table a row is from when the passage holds two, and looks at both", () => {
		// Before the review's fix only the first table was looked at, and its row was stated as the row of "this table" under both.
		const aid = tableRowsFor(`${machines}\n\n${table(36, 22)}`, QUESTION);
		expect(aid).toContain('[The row of the table headed "Machine | Driven by | Belt" with the question\'s words, each value after its column heading:\n- Machine: machine 3; Driven by: P-103; Belt: conveyor belt GT2]');
		expect(aid).toContain('[The row of the table headed "Part | Frame | Rated current | Holding torque | Notes" with the question\'s words, each value after its column heading:\n- Part: P-122; Frame: size 17; Rated current: 1.50 A; Holding torque: 20 N·cm; Notes: drives the conveyor]');
		expect(aid).not.toContain("this table");
		// The answer in the second table only.
		expect(tableRowsFor(`${table(36)}\n\n${machines}`, "which machine has the GT2 conveyor belt?")).toBe('\n[The row of the table headed "Machine | Driven by | Belt" with the question\'s words, each value after its column heading:\n- Machine: machine 3; Driven by: P-103; Belt: conveyor belt GT2]');
	});

	it("is unchanged for a passage with one table, states empty cells as empty, and is not misled by a line with a bar under the table", () => {
		const one = "\n[The row of this table with the question's words, each value after its column heading:\n- Part: P-122; Frame: size 17; Rated current: 1.50 A; Holding torque: 20 N·cm; Notes: drives the conveyor]";
		expect(tableRowsFor(table(36, 22), "which part drives the conveyor?")).toBe(one);
		expect(tableRowsFor(`${table(36, 22)}\nSee also the conveyor | belt notes.`, "which part drives the conveyor?")).toBe(one);
		const sparse = `${head}\n${Array.from({ length: 8 }, (_, i) => (i === 3 ? "| P-103 | | | | spare |" : row(i))).join("\n")}`;
		expect(tableRowsFor(sparse, "what about the spare?")).toContain("- Part: P-103; Frame: (empty); Rated current: (empty); Holding torque: (empty); Notes: spare]");
	});
});
