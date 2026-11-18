import { describe, expect, it } from "vitest";
import { BusyGate } from "../src/busy";
import { MessageQueue } from "../src/message-queue";
import { AgentView } from "../src/view";

/**
 * The chat view's handling of messages sent while the model is busy, run on the view's real methods
 * with the parts that need a DOM replaced: what is queued, when it is sent, and what Stop and a
 * failed turn do with it.
 */

interface Harness {
	queue: MessageQueue;
	running: boolean;
	gardening: boolean;
	quizBusy: boolean;
	quiz: null;
	lease: { stop(): void } | null;
	inputEl: { value: string };
	plugin: { busy: BusyGate };
	delivered: string[];
	submit(): Promise<void>;
	send(text: string, attach?: boolean): Promise<void>;
	stop(): void;
	turnEnded(stopped: boolean, failed: boolean): void;
	scheduleDrain(): void;
	finishTurn(): void;
}

/** A view whose `deliver` only records the message and marks the chat as running, as a real turn does before its first await. */
function view(): Harness {
	const v = Object.create(AgentView.prototype) as Harness & Record<string, unknown>;
	v.queue = new MessageQueue();
	v.running = false;
	v.gardening = false;
	v.quizBusy = false;
	v.quiz = null;
	v.lease = null;
	v.inputEl = { value: "" };
	v.plugin = { busy: new BusyGate() };
	v.delivered = [];
	v.renderQueue = () => undefined;
	v.autoGrow = () => undefined;
	v.deliver = async (item: { text: string }) => {
		v.delivered.push(item.text);
		// Commands end at once; anything else is a turn that runs until finishTurn().
		if (!item.text.startsWith("/")) v.running = true;
	};
	v.finishTurn = () => {
		v.running = false;
		v.turnEnded(false, false);
	};
	return v;
}

/** Lets the zero-delay timers the view uses for draining run (several in a row; a timer tick is up to 16 ms on Windows). */
const settle = () => new Promise((r) => setTimeout(r, 120));

async function type(v: Harness, text: string): Promise<void> {
	v.inputEl.value = text;
	await v.submit();
}

describe("messages sent while the chat is busy", () => {
	it("sends at once when nothing is running, and frees the message box", async () => {
		const v = view();
		await type(v, "  What is in my inbox?  ");
		expect(v.delivered).toEqual(["What is in my inbox?"]);
		expect(v.inputEl.value).toBe("");
		expect(v.queue.size).toBe(0);
	});

	it("queues instead of dropping while a turn runs, and sends one per finished turn, in order", async () => {
		const v = view();
		await type(v, "first");
		await type(v, "second");
		await type(v, "third");
		expect(v.delivered).toEqual(["first"]);
		expect(v.queue.list.map((m) => m.text)).toEqual(["second", "third"]);
		expect(v.inputEl.value).toBe("");

		v.finishTurn();
		await settle();
		expect(v.delivered).toEqual(["first", "second"]);
		expect(v.queue.list.map((m) => m.text)).toEqual(["third"]);

		v.finishTurn();
		await settle();
		expect(v.delivered).toEqual(["first", "second", "third"]);
		expect(v.queue.size).toBe(0);
	});

	it("does not send anything from an empty message box", async () => {
		const v = view();
		await type(v, "   ");
		expect(v.delivered).toEqual([]);
		expect(v.queue.size).toBe(0);
	});

	it("hands the queue back to the message box on Stop, before what is being typed", async () => {
		const v = view();
		let stopped = 0;
		await type(v, "first");
		v.lease = { stop: () => stopped++ };
		await type(v, "second");
		await type(v, "third");
		v.inputEl.value = "half a thought";
		v.stop();
		expect(stopped).toBe(1);
		expect(v.queue.size).toBe(0);
		expect(v.inputEl.value).toBe("second\n\nthird\n\nhalf a thought");
		// The stopped turn unwinds: nothing more is sent.
		v.running = false;
		v.turnEnded(true, false);
		await settle();
		expect(v.delivered).toEqual(["first"]);
	});

	it("does not send the queue after a turn that failed", async () => {
		const v = view();
		await type(v, "first");
		await type(v, "second");
		v.running = false;
		v.turnEnded(false, true);
		await settle();
		expect(v.delivered).toEqual(["first"]);
		expect(v.inputEl.value).toBe("second");
		expect(v.queue.size).toBe(0);
	});

	it("queues a message while a scheduled job has the model, and sends it when the job is done", async () => {
		const v = view();
		const job = v.plugin.busy.acquire("job", "Weekly digest")!;
		await type(v, "What changed this week?");
		expect(v.delivered).toEqual([]);
		expect(v.queue.size).toBe(1);
		// A command needs no model: it runs while the job does.
		await type(v, "/history");
		expect(v.delivered).toEqual(["/history"]);
		job.release();
		// The view listens to the gate; here the listener's effect is called directly.
		v.scheduleDrain();
		await settle();
		expect(v.delivered).toEqual(["/history", "What changed this week?"]);
	});

	it("runs queued commands one after another without waiting for a turn", async () => {
		const v = view();
		await type(v, "first");
		await type(v, "/help");
		await type(v, "/history");
		await type(v, "second");
		v.finishTurn();
		await settle();
		expect(v.delivered).toEqual(["first", "/help", "/history", "second"]);
	});

	it("leaves the message box alone when a command sends a prompt for the user", async () => {
		const v = view();
		v.inputEl.value = "my draft";
		await v.send("Reformat [[Note]]", false);
		expect(v.delivered).toEqual(["Reformat [[Note]]"]);
		expect(v.inputEl.value).toBe("my draft");
		// While that runs, a second command is queued, still without touching the draft.
		await v.send("Summarise [[Note]]");
		expect(v.queue.list.map((m) => ({ text: m.text, attach: m.attach }))).toEqual([{ text: "Summarise [[Note]]", attach: true }]);
		expect(v.inputEl.value).toBe("my draft");
	});
});
