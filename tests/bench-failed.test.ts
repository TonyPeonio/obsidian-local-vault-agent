import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FailedChecks, failuresOfRun } from "../scripts/bench-failed";

/**
 * The list of failed checks in a benchmark result file. The benchmark itself needs a model; what
 * builds the list does not, so it is fed here the lines a run prints.
 */

/** The lines of a run limited to `code-snippets`, as `bench/0.9.0-cs4-1.json` was made: its own checks pass, then come the checks the script makes after scenarios that were left out. */
function limitedRun(f: FailedChecks, tellOfSkips: boolean): void {
	const skip = () => {
		if (tellOfSkips) f.skipped();
	};
	skip(); // qa-lecture … daily-survey: left out, nothing printed
	f.line("\n=== [code-snippets] Collect code blocks");
	f.line("--- 14.2 s, 5 calls, max prompt 9000 tok:\nDone.\n");
	f.line("  PASS  used ≤ 10 tool calls");
	f.line("  PASS  Code Snippets.md was created");
	skip(); // quotes-regex
	skip(); // rejection, whose check of the note is printed all the same
	f.line("  PASS  the note is unchanged after the rejection");
	skip(); // distill
	f.line("  FAIL  created topic notes in Topics/ (0)");
	f.line("  FAIL  collected both code snippets");
	skip(); // fix-link
	f.line("  FAIL  removed the broken link to Projects/Gantry Spec");
}

describe("the failed checks a benchmark result lists", () => {
	it("a full run: every failed check is filed under its scenario, the checks after the answer included", () => {
		const f = new FailedChecks();
		f.line("\n=== [qa-lecture] Find a lecture by concept");
		f.line("  PASS  names the ML course or note");
		f.line("  FAIL  cites with a wikilink");
		f.line("\n=== [code-snippets] Collect code blocks");
		f.line("  PASS  used ≤ 10 tool calls");
		f.line("  FAIL  cites both daily notes");
		f.line("\n=== [rejection] The user rejects the change");
		f.line("  PASS  asks what to do instead");
		expect(f.of("qa-lecture")).toEqual(["cites with a wikilink"]);
		expect(f.of("rejection")).toEqual([]);
		expect(f.list(["qa-lecture", "code-snippets", "rejection"])).toEqual(["qa-lecture: cites with a wikilink", "code-snippets: cites both daily notes"]);
	});

	it("a run limited with ONLY= lists no check of a scenario that did not run", () => {
		const f = new FailedChecks();
		limitedRun(f, true);
		expect(f.of("code-snippets")).toEqual([]);
		expect(f.list(["code-snippets"])).toEqual([]);
	});

	it("the fault it had: not told of the scenarios left out, it files their checks under the one that ran", () => {
		const f = new FailedChecks();
		limitedRun(f, false);
		expect(f.list(["code-snippets"])).toEqual([
			"code-snippets: created topic notes in Topics/ (0)",
			"code-snippets: collected both code snippets",
			"code-snippets: removed the broken link to Projects/Gantry Spec",
		]);
	});

	it("a scenario that runs after ones that were left out has its own failed checks", () => {
		const f = new FailedChecks();
		limitedRun(f, true);
		f.line("\n=== [edit-selection] Edit the selected text");
		f.line("  FAIL  the selected line now ends with the tag");
		expect(f.list(["code-snippets", "edit-selection"])).toEqual(["edit-selection: the selected line now ends with the tag"]);
		expect(f.current).toBe("edit-selection");
	});

	it("the count of failures leaves out what the checks after skipped scenarios counted", () => {
		// bench/0.9.0-cs4-1.json: 8 of 8 passed, and "failures": 11.
		expect(failuresOfRun(11, [{ fail: 0 }, { fail: 4, skipped: true }, { fail: 7, skipped: true }])).toBe(0);
		// A failure of a scenario that ran, and one of the closing undo check, which has no row.
		expect(failuresOfRun(13, [{ fail: 1 }, { fail: 11, skipped: true }])).toBe(2);
		expect(failuresOfRun(3, [{ fail: 2 }, { fail: 1 }])).toBe(3);
	});

	it("the benchmark script tells it of every scenario ONLY leaves out, and uses it for the list and the count", () => {
		// The script cannot run without a model, so its wiring is read.
		const script = readFileSync("scripts/e2e-large.ts", "utf8");
		const skipBranch = /if \(ONLY && !ONLY\.split\(","\)\.includes\(id\)\) \{[\s\S]*?return;/.exec(script)?.[0] ?? "";
		expect(skipBranch).toContain("skipped: true");
		expect(skipBranch).toContain("failedChecks.skipped()");
		expect(script).toContain("failed: failedChecks.list(rows.map((r) => r.id))");
		expect(script).toContain("failures = failuresOfRun(failures, rows)");
		expect(script.indexOf("failures = failuresOfRun(failures, rows)")).toBeLessThan(script.indexOf("const ranRows = rows.filter((r) => !r.skipped)"));
	});
});
