import { describe, expect, it } from "vitest";
import { buildOutline, outlineBudget } from "../src/outline";
import { FakeVault } from "./fakes";

function vault(n = 3): FakeVault {
	const v = new FakeVault({
		"Welcome.md": "# Welcome\n\nhello #intro",
		"Projects/Chess Robot.md": "# Chess Robot\n\n## Status\n\nok\n\n## Open problems\n\nx\n\n#project",
		"Projects/Engine Notes.md": "no headings here",
	});
	for (let i = 0; i < n; i++) v.seed(`Daily/2026-01-${String(i + 1).padStart(2, "0")}.md`, `# Day ${i}\n\n- stuff`);
	return v;
}

describe("buildOutline", () => {
	it("lists every note grouped by folder with headings and tags when it fits", () => {
		const out = buildOutline(vault(), 10_000);
		expect(out).toContain("/\n  Welcome.md — Welcome #intro");
		expect(out).toContain("Projects/\n  Chess Robot.md — Chess Robot › Status › Open problems #project\n  Engine Notes.md");
		expect(out).toContain("Daily/\n  2026-01-01.md — Day 0");
	});

	it("drops headings, then notes, to stay within budget", () => {
		const full = buildOutline(vault(), 10_000);
		const bare = buildOutline(vault(), full.length - 1);
		expect(bare).not.toContain("›");
		expect(bare).toContain("  Chess Robot.md\n  Engine Notes.md");
		const cut = buildOutline(vault(40), 100);
		expect(cut.length).toBeLessThanOrEqual(100);
		expect(cut).toMatch(/…and \d+ more notes/);
	});

	it("keeps every folder visible when bare names do not fit, collapsing the big ones", () => {
		// 40 daily notes do not fit in 300 chars, but every folder still appears: the small ones
		// in full, Daily/ as one line with its count and range. Before, the alphabetical prefix
		// fallback dropped Projects/ and Welcome.md entirely.
		const v = vault(40);
		const out = buildOutline(v, 300);
		expect(out.length).toBeLessThanOrEqual(300);
		expect(out).toContain("Projects/\n  Chess Robot.md\n  Engine Notes.md");
		expect(out).toContain("/\n  Welcome.md");
		expect(out).toContain("Daily/ (40 notes, 2026-01-01 … 2026-01-40; list_notes shows them)");
		expect(out).not.toContain("more notes");
		// With a little more room the mid-sized folder is listed and only the biggest collapses.
		for (let i = 0; i < 8; i++) v.seed(`Zettel/Note ${i}.md`, "# n");
		const mid = buildOutline(v, 450);
		expect(mid.length).toBeLessThanOrEqual(450);
		expect(mid).toContain("Zettel/\n  Note 0.md");
		expect(mid).toMatch(/^Daily\/ \(40 notes/m);
	});

	it("budget scales with the context window", () => {
		expect(outlineBudget(16384)).toBeGreaterThan(5000);
		expect(outlineBudget(32768)).toBe(outlineBudget(16384) * 2);
	});
});

describe("buildOutline with gists", () => {
	it("prefers gists over headings and rations them to recent notes under a tight budget", () => {
		const v = vault(6);
		const gist = (p: string) => (p.startsWith("Daily/") ? `Day gist for ${p}` : undefined);
		const all = buildOutline(v, { budgetChars: 10_000, gist });
		expect(all).toContain("  2026-01-01.md — Day gist for Daily/2026-01-01.md");
		expect(all).toContain("Chess Robot.md — Chess Robot › Status › Open problems #project"); // no gist → headings
		const tight = buildOutline(v, { budgetChars: all.length - 10, gist });
		expect(tight).toContain("Day gist for Daily/2026-01-06.md"); // most recent keeps its gist
		expect(tight).not.toContain("Day gist for Daily/2026-01-01.md");
		expect(tight).toContain("  2026-01-01.md — Day 0"); // older note falls back to headings
		expect(outlineBudget(32768, true)).toBeGreaterThan(outlineBudget(32768));
	});
});
