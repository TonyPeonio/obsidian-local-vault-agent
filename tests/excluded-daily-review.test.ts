import { beforeEach, describe, expect, it } from "vitest";
import { Notice } from "obsidian";
import { BusyGate } from "../src/busy";
import { t } from "../src/i18n";
import LocalVaultAgentPlugin from "../src/main";
import { JOB_NAMES, PendingQueue, RETRY_DELAYS_MS, dueJobs, type JobId, type JobRetry } from "../src/scheduler";

/**
 * Review of 8636eef (the nightly job on an excluded daily notes folder): what a user finds the
 * next morning, night after night, and what happens once they have done something about it.
 */

const shown = (Notice as unknown as { shown: string[] }).shown;
const hidden = (Notice as unknown as { hidden: string[] }).hidden;
const SCHEDULED_NOTICE = t("job.excludedDaily", { job: JOB_NAMES.daily });
const MANUAL_NOTICE = t("notice.excludedDaily");
const schedule = { nightlyDaily: true, nightlyTime: "02:00", weeklyDigest: false, digestDay: 0, digestTime: "09:00", digestFolder: "" };

beforeEach(() => {
	shown.length = 0;
	hidden.length = 0;
});

/**
 * runJob on a stand-in for the plugin. `dailyFolder` is the folder as the plugin last read it;
 * `inDailyNotes` is what the Daily Notes plugin is set to now, which `loadDailyNoteSettings` reads.
 */
function job(dailyFolder: string, excludedFolders: string[], inDailyNotes = dailyFolder) {
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
		loads: 0,
		ran: [] as string[],
		errors: [] as string[],
		dailyFolder,
		loadDailyNoteSettings: async () => {
			p.loads++;
			p.dailyFolder = inDailyNotes;
		},
		saveSettings: async () => void p.saves++,
		notifyError: (message: string) => void p.errors.push(message),
		notifyPending: () => undefined,
		// The job proper, as far as this test needs it: it reads the folder afresh, like the real one.
		runDailyJob: async () => {
			await p.loadDailyNoteSettings();
			p.ran.push(`daily on ${p.dailyFolder}`);
			return [];
		},
		runDigestJob: async () => [],
		runJob: proto.runJob,
		settleJob: proto.settleJob,
		skipExcludedDaily: proto.skipExcludedDaily,
		dailyFolderExcluded: proto.dailyFolderExcluded,
	};
	return p;
}
const runJob = (p: ReturnType<typeof job>, manual: boolean) => LocalVaultAgentPlugin.prototype.runJob.call(p as unknown as LocalVaultAgentPlugin, "daily", manual);

describe("the nightly job after the user pointed Daily Notes at a folder that is not excluded", () => {
	it("scheduled: the job reads the folder afresh and runs, instead of saying 'excluded' about the old folder", async () => {
		// The plugin last read "Journal" (excluded). Since then Daily Notes was set to "Daily".
		const p = job("Journal", ["Journal"], "Daily");
		p.settings.jobRuns.daily = 1000;
		await runJob(p, false);
		expect(p.ran).toEqual(["daily on Daily"]);
		expect(shown).toEqual([]);
		expect(p.errors).toEqual([]);
		expect(p.settings.jobRuns.daily).toBeGreaterThan(1000);
		expect(p.busy.busy).toBe(false);
		expect(p.jobRunning).toBe(false);
	});

	it("run by hand: the same", async () => {
		const p = job("Journal", ["Journal"], "Daily");
		await runJob(p, true);
		expect(p.ran).toEqual(["daily on Daily"]);
		expect(shown).not.toContain(MANUAL_NOTICE);
	});

	it("still excluded after the fresh read: nothing runs, as before, and the folder is read once, not in a loop", async () => {
		const p = job("Journal", ["Journal"]);
		p.settings.jobRuns.daily = 1000;
		await runJob(p, false);
		expect(p.ran).toEqual([]);
		expect(p.loads).toBe(1);
		expect(shown).toEqual([SCHEDULED_NOTICE]);
	});

	it("a job that is already running is not started a second time by the fresh read", async () => {
		const p = job("Journal", ["Journal"], "Daily");
		const first = runJob(p, false);
		const second = runJob(p, false);
		await Promise.all([first, second]);
		expect(p.ran).toEqual(["daily on Daily"]);
		expect(p.busy.busy).toBe(false);
	});
});

describe("night after night on a folder that stays excluded", () => {
	it("each night: one notice, the run recorded, not due again that night, no retry set; the notice of the night before is taken down", async () => {
		const p = job("Journal", ["Journal"]);
		// Turned on some days ago, never run since.
		p.settings.jobRuns.daily = 1000;
		for (let night = 1; night <= 7; night++) {
			expect(dueJobs(new Date(), schedule, p.settings.jobRuns, p.jobRetries), `night ${night}`).toEqual(["daily"]);
			await runJob(p, false);
			expect(p.jobRetries.daily, `night ${night}`).toBeUndefined();
			// The checks that follow every minute of that night, and after each wait a failure would have set.
			for (const later of [60_000, ...RETRY_DELAYS_MS, 6 * 3_600_000]) {
				// Not later than the next scheduled time, which is a new night.
				const at = new Date(Math.min(Date.now() + later, nextNight(p.settings.jobRuns.daily as number) - 1));
				expect(dueJobs(at, schedule, p.settings.jobRuns, p.jobRetries), `night ${night} + ${later}`).toEqual([]);
			}
			// The next night: the stand-in for a day passing is a run recorded a day earlier.
			p.settings.jobRuns.daily = (p.settings.jobRuns.daily as number) - 86_400_000;
		}
		expect(p.ran).toEqual([]);
		expect(p.errors).toEqual([]);
		expect(shown).toEqual(Array.from({ length: 7 }, () => SCHEDULED_NOTICE));
		// Six of the seven were taken down again: one is on the screen in the morning, not seven.
		expect(hidden).toEqual(Array.from({ length: 6 }, () => SCHEDULED_NOTICE));
		expect(p.saves).toBe(7);
	});

	it("says what to do about it, in two sentences", () => {
		expect(SCHEDULED_NOTICE).toContain("Settings → Local Vault Agent → Excluded folders");
		expect(SCHEDULED_NOTICE).toContain("will not be tried again before its next scheduled time");
	});
});

/** The first 02:00 after `ms`. */
function nextNight(ms: number): number {
	const d = new Date(ms);
	const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 2, 0, 0, 0);
	if (at.getTime() <= ms) at.setDate(at.getDate() + 1);
	return at.getTime();
}
