import { beforeEach, describe, expect, it } from "vitest";
import { Modal, Notice } from "obsidian";
import { BusyGate } from "../src/busy";
import { t } from "../src/i18n";
import LocalVaultAgentPlugin from "../src/main";
import type { ProcessDailyOptions } from "../src/prompts";
import { JOB_NAMES, PendingQueue, afterRun, dueJobs, type JobId, type JobRetry } from "../src/scheduler";

/**
 * "Process my daily notes" when the daily notes folder is excluded: the command, `/daily`, and the
 * nightly job. The rule of every command since bd29906: aimed at an excluded folder it does
 * nothing and says so.
 */

const shown = (Notice as unknown as { shown: string[] }).shown;
const opened = (Modal as unknown as { opened: unknown[] }).opened;
const NOTICE = t("notice.excludedDaily");

beforeEach(() => {
	shown.length = 0;
	opened.length = 0;
});

/** The command on a stand-in for the plugin: the dialog is the real one, the chat view records what would be sent to the model. */
function command(dailyFolder: string, excludedFolders: string[]) {
	const sent: string[] = [];
	const state = { saves: 0 };
	const view = { send: async (m: string) => void sent.push(m) };
	const p = Object.assign(Object.create(LocalVaultAgentPlugin.prototype) as LocalVaultAgentPlugin, {
		app: {},
		dailyFolder,
		settings: { excludedFolders, dailyInboxHeading: "Capture", dailyTopicsFolder: "Topics", dailyMoveItems: false },
		saveSettings: async () => void state.saves++,
		activateView: async () => view,
	});
	/** Runs the command and presses "Run" in its dialog, after changing the options when `change` is given. */
	const run = async (change: Partial<ProcessDailyOptions> = {}) => {
		const running = p.processDailyNotes();
		const modal = opened[opened.length - 1] as { opts: ProcessDailyOptions; resolve: (o: ProcessDailyOptions | null) => void };
		modal.resolve({ ...modal.opts, ...change });
		await running;
	};
	return { p, sent, state, run };
}

describe("the command on an excluded daily notes folder does nothing and says why", () => {
	it("says it in one sentence that names the setting", () => {
		expect(NOTICE).toMatch(/daily notes folder is excluded/);
		expect(NOTICE).toMatch(/Excluded folders/);
		expect(NOTICE.match(/[.!?](\s|$)/g)).toHaveLength(1);
	});

	it("nothing is sent to the model, no setting is saved, and a notice is shown", async () => {
		const x = command("Journal", ["Journal"]);
		await x.run({ heading: "Inbox" });
		expect(x.sent).toEqual([]);
		expect(x.state.saves).toBe(0);
		expect((x.p as unknown as { settings: { dailyInboxHeading: string } }).settings.dailyInboxHeading).toBe("Capture");
		expect(shown).toEqual([NOTICE]);
	});

	it("also when the folder is inside an excluded folder, in any letter case", async () => {
		for (const [folder, excluded] of [
			["Private/Daily", ["private"]],
			["journal", [" /Journal/ "]],
			["Journal/", ["Archive", "Journal"]],
		] as [string, string[]][]) {
			shown.length = 0;
			const x = command(folder, excluded);
			await x.run();
			expect(x.sent, folder).toEqual([]);
			expect(shown, folder).toEqual([NOTICE]);
		}
	});

	it("decides by the folder the dialog was confirmed with", async () => {
		// Changed in the dialog to a folder that is not excluded: the command runs on that one.
		const moved = command("Journal", ["Journal"]);
		await moved.run({ folder: "Daily" });
		expect(moved.sent).toHaveLength(1);
		expect(moved.sent[0]).toContain('"Daily/" folder');
		expect(moved.sent[0]).not.toContain("Journal");
		expect(shown).toEqual([]);
		// Changed to an excluded one: nothing.
		const into = command("Daily", ["Journal"]);
		await into.run({ folder: "Journal" });
		expect(into.sent).toEqual([]);
		expect(shown).toEqual([NOTICE]);
	});

	it("runs as before on a folder that is not excluded, on the vault root, and on a folder whose name only begins like an excluded one", async () => {
		for (const [folder, excluded] of [
			["Daily", ["Private"]],
			["", ["Private", "Journal"]],
			["Journalism", ["Journal"]],
			["Daily", []],
		] as [string, string[]][]) {
			const x = command(folder, excluded);
			await x.run();
			expect(x.sent, folder).toHaveLength(1);
			expect(x.sent[0]).toContain(folder ? `"${folder}/" folder` : "the vault root");
			expect(x.state.saves).toBe(1);
		}
		expect(shown).toEqual([]);
	});

	it("a cancelled dialog does nothing and shows nothing, excluded or not", async () => {
		const x = command("Journal", ["Journal"]);
		const running = x.p.processDailyNotes();
		(opened[0] as { resolve: (o: null) => void }).resolve(null);
		await running;
		expect(x.sent).toEqual([]);
		expect(shown).toEqual([]);
	});
});

/** runJob on a stand-in, as in main-jobs.test.ts, with the plugin's own test of the daily notes folder. */
function job(dailyFolder: string, excludedFolders: string[]) {
	const proto = LocalVaultAgentPlugin.prototype as unknown as Record<string, unknown>;
	const p = {
		busy: new BusyGate(),
		pending: new PendingQueue(),
		settings: { jobRuns: {} as Partial<Record<JobId, number>>, excludedFolders },
		jobRetries: {} as Partial<Record<JobId, JobRetry>>,
		jobRunning: false,
		unloaded: false,
		pendingNotified: 0,
		saves: 0,
		ran: [] as string[],
		errors: [] as string[],
		dailyFolder,
		loadDailyNoteSettings: async () => undefined,
		saveSettings: async () => void p.saves++,
		notifyError: (message: string) => void p.errors.push(message),
		notifyPending: () => undefined,
		runDailyJob: async () => (p.ran.push("daily"), []),
		runDigestJob: async () => (p.ran.push("digest"), []),
		settleJob: proto.settleJob,
		skipExcludedDaily: proto.skipExcludedDaily,
		dailyFolderExcluded: proto.dailyFolderExcluded,
	};
	return p;
}
const runJob = (p: ReturnType<typeof job>, id: JobId, manual: boolean) => LocalVaultAgentPlugin.prototype.runJob.call(p as unknown as LocalVaultAgentPlugin, id, manual);

describe("the nightly job on an excluded daily notes folder", () => {
	const schedule = { nightlyDaily: true, nightlyTime: "02:00", weeklyDigest: false, digestDay: 0, digestTime: "09:00", digestFolder: "" };
	const SCHEDULED_NOTICE = t("job.excludedDaily", { job: JOB_NAMES.daily });

	it("a skipped run is recorded like a finished one: the schedule's own rule", () => {
		expect(afterRun("skipped", 5000)).toEqual({ record: true, gaveUp: false });
		expect(afterRun("skipped", 5000, { failures: 2, retryAt: 9000 })).toEqual({ record: true, gaveUp: false });
	});

	it("scheduled: the job does not run, says why, and is not due again before its next time", async () => {
		const p = job("Journal", ["Journal"]);
		p.settings.jobRuns.daily = 1000;
		const now = new Date();
		expect(dueJobs(now, schedule, p.settings.jobRuns, p.jobRetries)).toEqual(["daily"]);
		await runJob(p, "daily", false);
		expect(p.ran).toEqual([]);
		expect(shown).toEqual([SCHEDULED_NOTICE]);
		expect(SCHEDULED_NOTICE).toContain("Nightly: process my daily notes did not run");
		// Not a failure: no error notice, no retry in 5, 15 and 60 minutes.
		expect(p.errors).toEqual([]);
		expect(p.jobRetries.daily).toBeUndefined();
		// Recorded as this time's run, so the check a minute later does not find it due and say it again.
		expect(p.settings.jobRuns.daily).toBeGreaterThan(1000);
		expect(p.saves).toBe(1);
		expect(dueJobs(new Date(), schedule, p.settings.jobRuns, p.jobRetries)).toEqual([]);
		expect(p.busy.busy).toBe(false);
		expect(p.jobRunning).toBe(false);
		expect(p.pending.size).toBe(0);
	});

	it("scheduled, while an earlier failure was waiting to be retried: the retry is dropped", async () => {
		const p = job("Journal", ["Journal"]);
		p.settings.jobRuns.daily = 1000;
		p.jobRetries.daily = { failures: 2, retryAt: Date.now() - 1 };
		await runJob(p, "daily", false);
		expect(p.ran).toEqual([]);
		expect(p.jobRetries.daily).toBeUndefined();
		expect(p.errors).toEqual([]);
	});

	it("run by hand: nothing runs, the notice says why, and the schedule is left as it was", async () => {
		const p = job("Private/Daily", ["Private"]);
		p.settings.jobRuns.daily = 1000;
		await runJob(p, "daily", true);
		expect(p.ran).toEqual([]);
		expect(shown).toEqual([NOTICE]);
		expect(p.settings.jobRuns.daily).toBe(1000);
		expect(p.saves).toBe(0);
		expect(p.busy.busy).toBe(false);
	});

	it("the folder was changed to an excluded one since the plugin last read it: the job itself stops before anything is sent", async () => {
		for (const manual of [false, true]) {
			shown.length = 0;
			const p = job("Daily", ["Journal"]);
			p.settings.jobRuns.daily = 1000;
			// The plugin's own job, which reads the Daily Notes plugin's folder afresh. The stand-in has no
			// model client and no vault: going any further would throw and be reported as a failure.
			const real = p as unknown as Record<string, unknown>;
			real.runDailyJob = (LocalVaultAgentPlugin.prototype as unknown as Record<string, unknown>).runDailyJob;
			real.loadDailyNoteSettings = async () => void (p.dailyFolder = "Journal");
			await runJob(p, "daily", manual);
			expect(p.errors).toEqual([]);
			expect(p.jobRetries.daily).toBeUndefined();
			expect(p.busy.busy).toBe(false);
			expect(p.jobRunning).toBe(false);
			if (manual) {
				// (A run by hand has by then said that it is running; the notice that it did not follows.)
				expect(shown[shown.length - 1]).toBe(NOTICE);
				expect(p.settings.jobRuns.daily).toBe(1000);
			} else {
				expect(shown).toEqual([SCHEDULED_NOTICE]);
				expect(p.settings.jobRuns.daily).toBeGreaterThan(1000);
			}
		}
	});

	it("the weekly digest is not touched by it, and the nightly job runs when the folder is not excluded", async () => {
		const p = job("Journal", ["Journal"]);
		await runJob(p, "digest", false);
		expect(p.ran).toEqual(["digest"]);
		const ok = job("Daily", ["Journal"]);
		await runJob(ok, "daily", false);
		expect(ok.ran).toEqual(["daily"]);
		expect(typeof ok.settings.jobRuns.daily).toBe("number");
		const root = job("", ["Journal"]);
		await runJob(root, "daily", false);
		expect(root.ran).toEqual(["daily"]);
		expect(shown).toEqual([]);
	});
});
