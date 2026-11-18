import { describe, expect, it } from "vitest";
import { BusyGate } from "../src/busy";
import LocalVaultAgentPlugin from "../src/main";
import { PendingQueue, type JobId, type JobRetry } from "../src/scheduler";

type Change = { path: string; tool: "create_note" | "edit_note"; before: string; after: string };

/**
 * runJob on a stand-in for the plugin: the gate, the queue and the schedule are the real ones, the
 * two jobs are whatever the test says (succeed, throw, or wait until they are stopped).
 */
function plugin(run: (signal?: AbortSignal) => Promise<Change[]>) {
	const proto = LocalVaultAgentPlugin.prototype as unknown as Record<string, unknown>;
	const p = {
		busy: new BusyGate(),
		pending: new PendingQueue(),
		settings: { jobRuns: {} as Partial<Record<JobId, number>> },
		jobRetries: {} as Partial<Record<JobId, JobRetry>>,
		jobRunning: false,
		unloaded: false,
		pendingNotified: 0,
		saves: 0,
		errors: [] as string[],
		saveSettings: async () => void p.saves++,
		notifyError: (message: string) => void p.errors.push(message),
		notifyPending: () => undefined,
		// The daily notes folder is not excluded here; tests/excluded-daily.test.ts covers the case that it is.
		dailyFolderExcluded: () => false,
		runDailyJob: run,
		runDigestJob: run,
		settleJob: proto.settleJob,
		stopJob: proto.stopJob,
	};
	return p;
}
type Stand = ReturnType<typeof plugin>;
const runJob = (p: Stand, job: JobId, manual: boolean) => LocalVaultAgentPlugin.prototype.runJob.call(p as unknown as LocalVaultAgentPlugin, job, manual);
const stopJob = (p: Stand) => LocalVaultAgentPlugin.prototype.stopJob.call(p as unknown as LocalVaultAgentPlugin);

const CHANGE: Change = { path: "Topics/Ideas.md", tool: "create_note", before: "", after: "# Ideas" };

/** A job that runs until its signal is aborted, like a model call that is stopped. */
function untilStopped(started: () => void) {
	return (signal?: AbortSignal) =>
		new Promise<Change[]>((resolve, reject) => {
			started();
			signal?.addEventListener("abort", () => reject(new Error("aborted")));
			void resolve;
		});
}

describe("running a scheduled job", () => {
	it("records the run when it is over, not when it starts, and queues its changes", async () => {
		let duringRun: number | undefined = -1;
		const p = plugin(async () => {
			duringRun = p.settings.jobRuns.daily;
			return [CHANGE];
		});
		await runJob(p, "daily", false);
		expect(duringRun).toBeUndefined();
		expect(typeof p.settings.jobRuns.daily).toBe("number");
		expect(p.saves).toBe(1);
		expect(p.pending.size).toBe(1);
		expect(p.busy.busy).toBe(false);
		expect(p.jobRunning).toBe(false);
	});

	it("leaves a failed scheduled run due and sets a retry, with one notice", async () => {
		const p = plugin(async () => {
			throw new Error("Cannot reach Ollama");
		});
		p.settings.jobRuns.daily = 1000;
		await runJob(p, "daily", false);
		// Not recorded: the old code had already written "now" here, so the job was skipped until the next night.
		expect(p.settings.jobRuns.daily).toBe(1000);
		expect(p.saves).toBe(0);
		expect(p.jobRetries.daily?.failures).toBe(1);
		expect(p.jobRetries.daily!.retryAt).toBeGreaterThan(Date.now() + 4 * 60_000);
		expect(p.errors.length).toBe(1);
		expect(p.errors[0]).toContain("Cannot reach Ollama");
		expect(p.errors[0]).toContain("5 minutes");
		expect(p.pending.size).toBe(0);
		expect(p.busy.busy).toBe(false);

		// The retries in between are silent; the fourth failure in a row gives up, records the run and says so.
		await runJob(p, "daily", false);
		await runJob(p, "daily", false);
		expect(p.errors.length).toBe(1);
		expect(p.jobRetries.daily?.failures).toBe(3);
		expect(p.settings.jobRuns.daily).toBe(1000);
		await runJob(p, "daily", false);
		expect(p.errors.length).toBe(2);
		expect(p.errors[1]).toContain("4 times");
		expect(p.jobRetries.daily).toBeUndefined();
		expect(p.settings.jobRuns.daily).toBeGreaterThan(1000);
	});

	it("forgets the failures once a run succeeds", async () => {
		let fail = true;
		const p = plugin(async () => {
			if (fail) throw new Error("down");
			return [];
		});
		await runJob(p, "digest", false);
		expect(p.jobRetries.digest?.failures).toBe(1);
		fail = false;
		await runJob(p, "digest", false);
		expect(p.jobRetries.digest).toBeUndefined();
		expect(typeof p.settings.jobRuns.digest).toBe("number");
	});

	it("can be stopped: nothing is queued, the gate is freed, and it is not reported as a failure", async () => {
		let started = false;
		const p = plugin(untilStopped(() => (started = true)));
		const running = runJob(p, "daily", false);
		expect(started).toBe(true);
		expect(p.busy.holder?.owner).toBe("job");
		expect(p.busy.holder?.label).toBe("Nightly: process my daily notes");
		expect(stopJob(p)).toBe(true);
		await running;
		expect(p.pending.size).toBe(0);
		expect(p.errors).toEqual([]);
		expect(p.busy.busy).toBe(false);
		expect(p.jobRunning).toBe(false);
		// The user said no for this time: recorded, no retry.
		expect(typeof p.settings.jobRuns.daily).toBe("number");
		expect(p.jobRetries.daily).toBeUndefined();
		expect(stopJob(p)).toBe(false);
	});

	it("queues nothing from a run that was stopped but returned what it had", async () => {
		const p = plugin(async (signal) => {
			await new Promise<void>((res) => signal?.addEventListener("abort", () => res()));
			return [CHANGE];
		});
		const running = runJob(p, "daily", true);
		stopJob(p);
		await running;
		expect(p.pending.size).toBe(0);
	});

	it("does not start while a chat turn has the model, and a chat turn cannot start while it runs", async () => {
		let runs = 0;
		const p = plugin(async () => {
			runs++;
			return [];
		});
		const chat = p.busy.acquire("chat")!;
		await runJob(p, "daily", false);
		expect(runs).toBe(0);
		expect(p.settings.jobRuns.daily).toBeUndefined();
		chat.release();

		const slow = plugin(untilStopped(() => undefined));
		const running = runJob(slow, "daily", false);
		expect(slow.busy.acquire("chat")).toBeNull();
		expect(slow.busy.acquire("quiz")).toBeNull();
		// A second job does not start on top of it either.
		await runJob(slow, "digest", true);
		expect(slow.settings.jobRuns.digest).toBeUndefined();
		stopJob(slow);
		await running;
		expect(slow.busy.acquire("chat")).not.toBeNull();
	});

	it("stays due when it was stopped because the plugin was unloaded", async () => {
		const p = plugin(untilStopped(() => undefined));
		p.settings.jobRuns.daily = 1000;
		const running = runJob(p, "daily", false);
		// What onunload does.
		p.unloaded = true;
		p.busy.stop("job");
		await running;
		expect(p.settings.jobRuns.daily).toBe(1000);
		expect(p.saves).toBe(0);
		expect(p.pending.size).toBe(0);
		expect(p.busy.busy).toBe(false);
	});

	it("leaves the schedule alone when a run started by hand fails", async () => {
		const p = plugin(async () => {
			throw new Error("model not found");
		});
		p.settings.jobRuns.digest = 1000;
		p.jobRetries.digest = { failures: 2, retryAt: 5 };
		await runJob(p, "digest", true);
		expect(p.settings.jobRuns.digest).toBe(1000);
		expect(p.jobRetries.digest).toEqual({ failures: 2, retryAt: 5 });
		expect(p.errors).toEqual(["Weekly digest failed: model not found"]);
	});
});
