import { afterEach, describe, expect, it, vi } from "vitest";
import { REGEX_BUDGET_MS, findInNote, grepVault, unsafeRegex } from "../src/tools";
import type { ToolContext } from "../src/types";
import { FakeVault } from "./fakes";

/**
 * Regular expressions come from the model and run on the UI thread. These tests pin the three
 * bounds: explosive patterns are refused before they run, a vault-wide search stops when the
 * matching has taken too long, and notes are read a batch at a time.
 */

function makeCtx(vault: FakeVault): ToolContext {
	return { vault, search: async () => [], approve: async () => "approve", maxResultChars: 12000 };
}

afterEach(() => {
	vi.restoreAllMocks();
});

/** Patterns a model plausibly sends that must keep working. */
const SAFE = [
	"^\\s*>\\s+[A-Z]",
	"TODO|FIXME",
	"!\\[\\[.*\\.(png|jpg)\\]\\]",
	"\\[\\[[^\\]]+\\]\\]",
	"^#{1,3} ",
	"https?://\\S+",
	".*foo.*bar",
	"(foo|bar)+",
	"(a|b)*",
	"(ab)+",
	"(a+)?",
	"((ab)+c)+",
	// A repeat inside a repeated group, but every round ends at a character the repeat cannot match.
	"(\\d+\\.)+\\d+",
	"([^,]*,)+",
	"(\\w+ )+end",
	"(-? ?\\d+,)+",
	"(?<year>\\d{4})-(\\d{2})",
	// Brackets and escaped parentheses are not groups.
	"[(a+)+]",
	"\\(a+\\)+",
	"status: (done|in progress)",
];

/** Patterns that backtrack exponentially on a line that almost matches. */
const UNSAFE = [
	"(a+)+",
	"(a*)*",
	"(?:a+)+$",
	"(\\w+\\s?)*:",
	"^(\\s*\\w+\\s*)+$",
	"(.*,)+",
	"(ab?)+c",
	"(x+x+)+y",
	"(a+){3,}",
	"(a{1,5})+",
	"((a+)b?)+",
	"(a+|b)+",
	"(a|aa)+$",
	"(ab|a|)+",
	"((\\d+\\.)+x)+",
];

describe("unsafeRegex", () => {
	it("lets ordinary patterns through", () => {
		for (const p of SAFE) expect([p, unsafeRegex(p)]).toEqual([p, null]);
	});
	it("refuses a repeated group with a repeat or an optional part inside, and overlapping alternatives", () => {
		for (const p of UNSAFE) expect([p, typeof unsafeRegex(p)]).toEqual([p, "string"]);
		expect(unsafeRegex("(a+)+")).toMatch(/repeats a group that has a repeat inside it/);
	});
	it("refuses a pattern that is too long, and has no opinion on one that is not a regular expression", () => {
		expect(unsafeRegex("a".repeat(301))).toBe("it is 301 characters long (the most is 300)");
		expect(unsafeRegex("a".repeat(300))).toBeNull();
		for (const p of ["[[Sensors", "(unclosed", "a)", "*", "a{2", "\\"]) expect(unsafeRegex(p)).toBeNull();
	});
	it("is right about the ones it lets through: none of them is slow on lines built to make it backtrack", () => {
		const probes = ["a".repeat(60) + "!", "1.".repeat(3000) + "x", "a,".repeat(3000) + "!", "word ".repeat(1500) + "!", "ab".repeat(3000) + "!", "- 1,".repeat(2000) + "!", "x".repeat(8000)];
		const started = performance.now();
		for (const p of SAFE) {
			const re = new RegExp(p, "i");
			for (const line of probes) re.exec(line);
		}
		// The whole table runs in a few milliseconds; an explosive pattern would not finish at all.
		expect(performance.now() - started).toBeLessThan(2000);
	});
});

describe("grep_vault with a regular expression that must not be run", () => {
	const vault = () => new FakeVault({ "A.md": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!\n(a+)+$ is written here\n" });
	it("refuses it with a reason and a way forward when regex is true", async () => {
		await expect(grepVault.execute({ pattern: "(a+)+$", regex: true }, makeCtx(vault()))).rejects.toThrow(
			"This regular expression was not run: it repeats a group that has a repeat inside it, like (a+)+ or (\\w+\\s?)*, which can freeze on a long line; use one repeat, such as [\\w ]+. Or search for a literal word.",
		);
		await expect(grepVault.execute({ pattern: "x".repeat(400), regex: true }, makeCtx(vault()))).rejects.toThrow(/was not run: it is 400 characters long/);
	});
	it("still searches it as the literal text it was sent as", async () => {
		expect(await grepVault.execute({ pattern: "(a+)+$" }, makeCtx(vault()))).toBe("1 matching line in 1 note:\nA.md:2: (a+)+$ is written here");
		// Nothing contains it literally, and it is not safe to try as an expression: a plain negative, quickly.
		expect(await grepVault.execute({ pattern: "(a+)+!!$" }, makeCtx(vault()))).toBe('No note contains "(a+)+!!$".');
	});
	it("find_in_note refuses it too, and still falls back to literal text for a pattern that is not an expression", async () => {
		await expect(findInNote.execute({ path: "A", pattern: "(a+)+$", regex: true }, makeCtx(vault()))).rejects.toThrow(/This regular expression was not run/);
		const out = await findInNote.execute({ path: "A", pattern: "(a+", regex: true }, makeCtx(vault()));
		expect(out).toMatch(/^\(The pattern is not a valid regular expression: .*Searched for it as literal text instead\.\)\n1 match in A\.md/);
	});
});

describe("grep_vault time budget", () => {
	function manyNotes(n: number): FakeVault {
		const vault = new FakeVault();
		for (let i = 0; i < n; i++) vault.seed(`Notes/N${String(i).padStart(3, "0")}.md`, `needle ${i}\n`);
		return vault;
	}
	it("stops a slow expression between notes and says the result is partial", async () => {
		// Every look at the clock is a second later: each note "takes" one second of matching.
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
		const out = await grepVault.execute({ pattern: "needle \\d+", regex: true }, makeCtx(manyNotes(100)));
		const searched = REGEX_BUDGET_MS / 1000 + 1;
		expect(out).toBe(
			`(This pattern is slow: the search was stopped after 3 s with ${searched} of 100 notes searched, so the result is incomplete. Narrow with folder or use a simpler pattern.)\n` +
				`${searched} matching lines in ${searched} notes:\n` +
				Array.from({ length: searched }, (_, i) => `Notes/N00${i}.md:1: needle ${i}`).join("\n--\n"),
		);
		// Nothing found before the stop is not "no note contains".
		clock = 0;
		expect(await grepVault.execute({ pattern: "zebra\\d", regex: true }, makeCtx(manyNotes(100)))).toMatch(/^\(This pattern is slow: .*\)\nNo match in the notes searched so far\.$/);
	});
	it("does not time a literal search, and a quick expression searches everything", async () => {
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
		expect(await grepVault.execute({ pattern: "needle", notes_only: true }, makeCtx(manyNotes(100)))).toMatch(/^100 matching lines in 100 notes/);
		vi.restoreAllMocks();
		expect(await grepVault.execute({ pattern: "needle \\d+$", regex: true, notes_only: true }, makeCtx(manyNotes(100)))).toMatch(/^100 matching lines in 100 notes/);
	});
	it("find_in_note stops a slow expression in a very long note", async () => {
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => (clock += 2000));
		const vault = new FakeVault({ "Big.md": Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") });
		const out = await findInNote.execute({ path: "Big", pattern: "line \\d+", regex: true, limit: 2 }, makeCtx(vault));
		// The clock is looked at every 200 lines; the second look is past the budget.
		expect(out).toMatch(/^\(This pattern is slow: the search was stopped after 3 s at line 399 of 1000, so the result is incomplete\. Use a simpler pattern\.\)\n399 matches in Big\.md/);
	});
	it("only tries an expression on the first 10,000 characters of a line, and says when a line was longer", async () => {
		const vault = new FakeVault({ "Long.md": `${"x".repeat(9000)} early ${"y".repeat(5000)} late\nshort early late\n` });
		const out = await grepVault.execute({ pattern: "early|late", regex: true }, makeCtx(vault));
		expect(out).toMatch(/^\(1 line longer than 10000 characters was only searched up to there\.\)\n2 matching lines in 1 note:\nLong\.md:1: ….* early .*…\nLong\.md:2: short early late$/);
		const late = await grepVault.execute({ pattern: "late$", regex: true }, makeCtx(vault));
		expect(late).toMatch(/^\(1 line longer than 10000 characters was only searched up to there\.\)\n1 matching line in 1 note:\nLong\.md:2: short early late$/);
		// Literal text is found wherever it is.
		expect(await grepVault.execute({ pattern: " late" }, makeCtx(vault))).toMatch(/^2 matching lines in 1 note:/);
	});
});

describe("grep_vault reads", () => {
	it("reads the notes a bounded batch at a time, each once, and finds what a whole-vault read found", async () => {
		const vault = new FakeVault();
		for (let i = 0; i < 150; i++) vault.seed(`Notes/N${String(i).padStart(3, "0")}.md`, i % 10 === 0 ? `the needle in ${i}\n` : "nothing\n");
		const read = vault.read.bind(vault);
		let inFlight = 0;
		let most = 0;
		const seen: string[] = [];
		vault.read = async (path: string) => {
			inFlight++;
			most = Math.max(most, inFlight);
			seen.push(path);
			await new Promise((resolve) => setTimeout(resolve, 0));
			inFlight--;
			return read(path);
		};
		const out = await grepVault.execute({ pattern: "needle", notes_only: true }, makeCtx(vault));
		expect(out).toMatch(/^15 matching lines in 15 notes \(lines per note\):\nNotes\/N000\.md: 1\n/);
		expect(most).toBeGreaterThan(1);
		expect(most).toBeLessThanOrEqual(32);
		expect(seen.length).toBe(150);
		expect(new Set(seen).size).toBe(150);
	});
	it("stops between batches when the run is aborted", async () => {
		const vault = new FakeVault();
		for (let i = 0; i < 100; i++) vault.seed(`Notes/N${i}.md`, "needle\n");
		const controller = new AbortController();
		const read = vault.read.bind(vault);
		let reads = 0;
		vault.read = async (path: string) => {
			if (++reads === 10) controller.abort();
			return read(path);
		};
		await expect(grepVault.execute({ pattern: "needle" }, { ...makeCtx(vault), signal: controller.signal })).rejects.toThrow("Stopped.");
		expect(reads).toBe(32);
	});
});
