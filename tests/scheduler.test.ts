import { describe, expect, it } from "vitest";
import { OverlayVault, PendingQueue, RETRY_DELAYS_MS, afterRun, dailyNotesBefore, digestPath, digestPrompt, dueJobs, ensureSources, lastScheduled, localDate, parseTime, planPending, recentNotes, renderDigest, type JobRetry, type ScheduleSettings } from "../src/scheduler";
import { FakeVault } from "./fakes";

const S: ScheduleSettings = { nightlyDaily: true, nightlyTime: "02:00", weeklyDigest: true, digestDay: 0, digestTime: "18:00", digestFolder: "Digests" };

describe("schedule", () => {
	it("parses HH:MM", () => {
		expect(parseTime("02:30")).toBe(150);
		expect(parseTime("7:05")).toBe(425);
		expect(parseTime("24:00")).toBeNull();
		expect(parseTime("noon")).toBeNull();
	});

	it("finds the last scheduled nightly time", () => {
		// Wednesday 2026-11-18 01:00 local: the last 02:00 was Tuesday's.
		expect(localDate(lastScheduled("daily", new Date(2026, 10, 18, 1, 0), S)!)).toBe("2026-11-17");
		expect(lastScheduled("daily", new Date(2026, 10, 18, 3, 0), S)!.getHours()).toBe(2);
		expect(localDate(lastScheduled("daily", new Date(2026, 10, 18, 3, 0), S)!)).toBe("2026-11-18");
		expect(lastScheduled("daily", new Date(), { ...S, nightlyDaily: false })).toBeNull();
	});

	it("finds the last scheduled weekly time", () => {
		// 2026-11-18 is a Wednesday; the last Sunday 18:00 was 2026-11-15.
		expect(localDate(lastScheduled("digest", new Date(2026, 10, 18, 12, 0), S)!)).toBe("2026-11-15");
		// On Sunday itself, before 18:00 it is the previous Sunday.
		expect(localDate(lastScheduled("digest", new Date(2026, 10, 22, 17, 0), S)!)).toBe("2026-11-15");
		expect(localDate(lastScheduled("digest", new Date(2026, 10, 22, 18, 30), S)!)).toBe("2026-11-22");
	});

	it("is due once the scheduled time passed since the last run, never without a recorded run", () => {
		const now = new Date(2026, 10, 18, 9, 0);
		expect(dueJobs(now, S, { daily: new Date(2026, 10, 17, 2, 5).getTime(), digest: new Date(2026, 10, 15, 18, 1).getTime() })).toEqual(["daily"]);
		expect(dueJobs(now, S, { daily: new Date(2026, 10, 18, 2, 1).getTime(), digest: new Date(2026, 10, 10).getTime() })).toEqual(["digest"]);
		expect(dueJobs(now, S, {})).toEqual([]);
	});
});

describe("what a nightly run may see and what it leaves behind", () => {
	it("hides daily notes older than its start date from every kind of access", async () => {
		const base = new FakeVault({
			"Daily/2026-08-30.md": "# old\n\n## Capture\n\n- from August",
			"Daily/2026-09-01.md": "# new\n\n## Capture\n\n- from September",
			"Daily/Templates/2026-01-01.md": "a dated note in a subfolder is not a daily note",
			"Projects/2026-01-01 kickoff.md": "a dated note elsewhere",
		});
		const o = new OverlayVault(base, dailyNotesBefore("Daily", "2026-09-01"));
		expect(o.listNotes().map((n) => n.path).sort()).toEqual(["Daily/2026-09-01.md", "Daily/Templates/2026-01-01.md", "Projects/2026-01-01 kickoff.md"]);
		expect(o.exists("Daily/2026-08-30.md")).toBe(false);
		expect(o.resolve("Daily/2026-08-30")).toBeNull();
		await expect(o.read("Daily/2026-08-30.md")).rejects.toThrow(/outside what this scheduled run covers/);
		await expect(o.modify("Daily/2026-08-30.md", "x")).rejects.toThrow(/outside what this scheduled run covers/);
		await o.modify("Daily/2026-09-01.md", "changed");
		expect((await o.changes()).map((c) => c.path)).toEqual(["Daily/2026-09-01.md"]);
	});

	it("adds the Sources a topic note is missing, from the daily notes that say their inbox moved there", () => {
		const daily = (path: string, to: string) => ({ path, tool: "edit_note" as const, before: "## Capture\n\n- stuff", after: `## Capture\n\n- Moved to [[${to}]]` });
		const out = ensureSources(
			[
				{ path: "Topics/Career.md", tool: "create_note", before: "", after: "# Career\n\n- Bison Oil and Gas\n" },
				{ path: "Topics/Immunology.md", tool: "create_note", before: "", after: "# Immunology\n\n- receptors\n\n## Sources\n\n- [[Daily/2026-09-14]]\n" },
				{ path: "Topics/Funding.md", tool: "edit_note", before: "# Funding\n\n## Sources\n\n- [[Daily/2026-08-01]]\n", after: "# Funding\n\n- NDSEG\n\n## Sources\n\n- [[Daily/2026-08-01]]\n" },
				daily("Daily/2026-09-01.md", "Topics/Career"),
				daily("Daily/2026-09-21.md", "Career"),
				daily("Daily/2026-09-14.md", "Topics/Immunology"),
				daily("Daily/2026-09-22.md", "Topics/Funding"),
			],
			"Daily",
		);
		expect(out[0].after).toBe("# Career\n\n- Bison Oil and Gas\n\n## Sources\n\n- [[Daily/2026-09-01]]\n- [[Daily/2026-09-21]]\n");
		// Already complete: untouched.
		expect(out[1].after).toBe("# Immunology\n\n- receptors\n\n## Sources\n\n- [[Daily/2026-09-14]]\n");
		// An existing Sources section gains the day that was missing.
		expect(out[2].after).toBe("# Funding\n\n- NDSEG\n\n## Sources\n\n- [[Daily/2026-09-22]]\n- [[Daily/2026-08-01]]\n");
		// Daily notes are never given a Sources section themselves.
		expect(out.slice(3).every((c) => !c.after.includes("## Sources"))).toBe(true);
	});

	it("leaves a run with nothing to add exactly as it was", () => {
		const changes = [{ path: "Topics/A.md", tool: "create_note" as const, before: "", after: "# A\n" }];
		expect(ensureSources(changes, "Daily")).toEqual(changes);
	});
});

describe("a scheduled run that failed, was stopped or finished", () => {
	// Wednesday 2026-11-18 02:00: the nightly job is due (last run the night before).
	const lastRuns = { daily: new Date(2026, 10, 17, 2, 5).getTime() };
	const at = (h: number, m: number) => new Date(2026, 10, 18, h, m);

	it("is recorded as run only when it finished or was stopped by the user", () => {
		expect(afterRun("done", 1000)).toEqual({ record: true, gaveUp: false });
		expect(afterRun("stopped", 1000)).toEqual({ record: true, gaveUp: false });
		// A success after earlier failures clears them.
		expect(afterRun("done", 1000, { failures: 2, retryAt: 500 })).toEqual({ record: true, gaveUp: false });
		expect(afterRun("failed", 1000).record).toBe(false);
	});

	it("is retried after 5, 15 and 60 minutes, then given up until the next scheduled time", () => {
		expect(RETRY_DELAYS_MS).toEqual([300_000, 900_000, 3_600_000]);
		const start = at(2, 0).getTime();
		const first = afterRun("failed", start);
		expect(first).toEqual({ record: false, retry: { failures: 1, retryAt: start + 300_000 }, gaveUp: false });
		const second = afterRun("failed", first.retry!.retryAt, first.retry);
		expect(second.retry).toEqual({ failures: 2, retryAt: start + 300_000 + 900_000 });
		const third = afterRun("failed", second.retry!.retryAt, second.retry);
		expect(third.retry?.failures).toBe(3);
		expect(third.retry!.retryAt - second.retry!.retryAt).toBe(3_600_000);
		// The fourth failure in a row ends it: recorded, and the user is told once.
		expect(afterRun("failed", third.retry!.retryAt, third.retry)).toEqual({ record: true, gaveUp: true });
	});

	it("stays due while it has not been recorded, but not before its retry time", () => {
		// Before the fix the run was recorded when it started, so a failure was not due again.
		expect(dueJobs(at(2, 1), S, lastRuns)).toEqual(["daily"]);
		const retry: JobRetry = afterRun("failed", at(2, 1).getTime()).retry!;
		expect(dueJobs(at(2, 2), S, lastRuns, { daily: retry })).toEqual([]);
		expect(dueJobs(at(2, 5), S, lastRuns, { daily: retry })).toEqual([]);
		expect(dueJobs(at(2, 6), S, lastRuns, { daily: retry })).toEqual(["daily"]);
		// Once recorded (success, stop or giving up) it is not due until the next night.
		const recorded = { daily: at(2, 7).getTime() };
		expect(dueJobs(at(2, 8), S, recorded)).toEqual([]);
		expect(dueJobs(new Date(2026, 10, 19, 2, 0), S, recorded)).toEqual(["daily"]);
	});

	it("does not hold back the other job", () => {
		const both = { daily: new Date(2026, 10, 17, 2, 5).getTime(), digest: new Date(2026, 10, 10).getTime() };
		const retry: JobRetry = { failures: 1, retryAt: at(9, 30).getTime() };
		expect(dueJobs(at(9, 0), S, both, { daily: retry })).toEqual(["digest"]);
	});
});

describe("OverlayVault", () => {
	it("keeps writes in memory and reports them as changes", async () => {
		const base = new FakeVault({ "Daily/2026-11-17.md": "## Capture\n- idea", "Topics/Old.md": "old" });
		const o = new OverlayVault(base);
		await o.create("Topics/Ideas.md", "# Ideas\n- idea");
		await o.modify("Daily/2026-11-17.md", "## Capture\n- Moved to [[Topics/Ideas]]");
		expect(await o.read("Topics/Ideas.md")).toBe("# Ideas\n- idea");
		expect(o.resolve("Ideas")).toBe("Topics/Ideas.md");
		expect(o.exists("Topics/Ideas.md")).toBe(true);
		expect(o.listNotes().map((n) => n.path)).toContain("Topics/Ideas.md");
		expect(o.getMetadata("Topics/Ideas.md").headings).toEqual(["# Ideas"]);
		// The real vault is untouched.
		expect(base.exists("Topics/Ideas.md")).toBe(false);
		expect(await base.read("Daily/2026-11-17.md")).toBe("## Capture\n- idea");
		expect(await o.changes()).toEqual([
			{ path: "Topics/Ideas.md", tool: "create_note", before: "", after: "# Ideas\n- idea" },
			{ path: "Daily/2026-11-17.md", tool: "edit_note", before: "## Capture\n- idea", after: "## Capture\n- Moved to [[Topics/Ideas]]" },
		]);
	});

	it("refuses moves and deletions, and drops edits that end where they started", async () => {
		const base = new FakeVault({ "A.md": "a" });
		const o = new OverlayVault(base);
		await expect(o.trash()).rejects.toThrow(/scheduled run/);
		await expect(o.rename()).rejects.toThrow(/scheduled run/);
		await expect(o.create("A.md", "x")).rejects.toThrow(/Already exists/);
		await o.modify("A.md", "b");
		await o.modify("A.md", "a");
		expect(await o.changes()).toEqual([]);
	});
});

describe("PendingQueue and planPending", () => {
	it("queues, replaces a job's older change to the same note, and round-trips through JSON", () => {
		const q = new PendingQueue();
		let events = 0;
		q.onChange(() => events++);
		q.add("daily", [{ path: "A.md", tool: "edit_note", before: "1", after: "2" }], 10);
		q.add("daily", [{ path: "A.md", tool: "edit_note", before: "2", after: "3" }], 20);
		expect(q.size).toBe(1);
		expect(q.list()[0]).toMatchObject({ before: "1", after: "3", summary: "Nightly: process my daily notes: edit A.md", time: 20 });
		const copy = new PendingQueue();
		copy.load(JSON.parse(JSON.stringify(q.toJSON())));
		expect(copy.list()).toEqual(q.list());
		copy.add("digest", [{ path: "B.md", tool: "create_note", before: "", after: "x" }]);
		expect(copy.list()[1].id).toBe(q.list()[0].id + 1);
		q.remove(q.list()[0].id);
		expect(q.size).toBe(0);
		expect(events).toBe(3);
	});

	it("applies a change onto a note edited elsewhere since, refuses overlaps and stale creates", async () => {
		const before = "# Day\n\n## Capture\n- idea one\n\n## Log\n- slept\n";
		const after = "# Day\n\n## Capture\n- Moved to [[Topics/Ideas]]\n\n## Log\n- slept\n";
		const vault = new FakeVault({ "D.md": before.replace("- slept", "- slept\n- ran 5k") });
		const q = new PendingQueue();
		const [edit] = q.add("daily", [{ path: "D.md", tool: "edit_note", before, after }]);
		const plan = await planPending(edit, vault);
		expect(plan).toMatchObject({ ok: true });
		if (plan.ok) expect(plan.after).toContain("- Moved to [[Topics/Ideas]]\n\n## Log\n- slept\n- ran 5k");

		await vault.modify("D.md", before.replace("- idea one", "- idea one, edited"));
		expect(await planPending(edit, vault)).toMatchObject({ ok: false });

		const [create] = q.add("digest", [{ path: "Digests/W.md", tool: "create_note", before: "", after: "x" }]);
		expect(await planPending(create, vault)).toMatchObject({ ok: true, after: "x" });
		await vault.create("Digests/W.md", "mine");
		expect(await planPending(create, vault)).toMatchObject({ ok: false, reason: expect.stringMatching(/created in the meantime/) });
	});
});

describe("digest", () => {
	it("picks the week's notes, writes the prompt and the note", () => {
		const now = new Date(2026, 10, 18, 18, 0);
		const day = 86_400_000;
		const notes = [
			{ path: "A.md", basename: "A", folder: "", mtime: now.getTime() - 1 * day, ctime: 0, size: 1 },
			{ path: "B.md", basename: "B", folder: "", mtime: now.getTime() - 10 * day, ctime: 0, size: 1 },
			{ path: "P/C.md", basename: "C", folder: "P", mtime: now.getTime() - 2 * day, ctime: 0, size: 1 },
		];
		const recent = recentNotes(notes, now);
		expect(recent.map((n) => n.path)).toEqual(["A.md", "P/C.md"]);
		expect(digestPrompt("2026-11-18", [{ path: "P/C.md", text: "chess" }])).toContain("--- P/C ---\nchess");
		expect(digestPath("Digests/", "2026-11-18")).toBe("Digests/Digest 2026-11-18.md");
		expect(digestPath("", "2026-11-18")).toBe("Digest 2026-11-18.md");
		const note = renderDigest("2026-11-18", "### Projects\n- x [[A]]", recent);
		expect(note).toMatch(/^# Weekly digest, week ending 2026-11-18\n\n### Projects/);
		expect(note).toContain("## Notes changed this week\n\n- [[A]] (2026-11-17)\n- [[P/C]] (2026-11-16)");
	});
});
