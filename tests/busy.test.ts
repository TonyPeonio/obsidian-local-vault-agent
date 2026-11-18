import { describe, expect, it } from "vitest";
import { BusyGate } from "../src/busy";

describe("the one-model-job-at-a-time gate", () => {
	it("lets one holder in and refuses the next until it is released", () => {
		const gate = new BusyGate();
		expect(gate.busy).toBe(false);
		const chat = gate.acquire("chat");
		expect(chat).not.toBeNull();
		expect(gate.busy).toBe(true);
		expect(gate.holder?.owner).toBe("chat");
		// A scheduled job that comes due during the chat turn does not start.
		expect(gate.acquire("job", "Weekly digest")).toBeNull();
		// Nor a second chat turn or a quiz.
		expect(gate.acquire("chat")).toBeNull();
		expect(gate.acquire("quiz")).toBeNull();
		chat!.release();
		expect(gate.busy).toBe(false);
		const job = gate.acquire("job", "Weekly digest");
		expect(job?.label).toBe("Weekly digest");
		// And the other way round: the chat waits for the job.
		expect(gate.acquire("chat")).toBeNull();
	});

	it("stops the holder through its signal, and the holder still knows it was stopped after releasing", () => {
		const gate = new BusyGate();
		const quiz = gate.acquire("quiz")!;
		let aborted = false;
		quiz.signal.addEventListener("abort", () => (aborted = true));
		expect(quiz.stopped).toBe(false);
		expect(gate.stop()).toBe(true);
		expect(aborted).toBe(true);
		expect(quiz.signal.aborted).toBe(true);
		expect(quiz.stopped).toBe(true);
		// Stopping does not free the gate: the stopped work is still unwinding.
		expect(gate.busy).toBe(true);
		expect(gate.acquire("chat")).toBeNull();
		quiz.release();
		expect(gate.busy).toBe(false);
		// The code that ran reads this in its `finally`, after the gate has moved on.
		expect(quiz.stopped).toBe(true);
	});

	it("stops only the named kind of work when one is named", () => {
		const gate = new BusyGate();
		expect(gate.stop()).toBe(false);
		const job = gate.acquire("job", "Nightly")!;
		expect(gate.stop("chat")).toBe(false);
		expect(job.stopped).toBe(false);
		expect(gate.stop("job")).toBe(true);
		expect(job.stopped).toBe(true);
		// Already stopped: nothing more to stop.
		expect(gate.stop("job")).toBe(false);
	});

	it("never lets an old lease free a newer holder", () => {
		const gate = new BusyGate();
		const first = gate.acquire("chat")!;
		first.release();
		const second = gate.acquire("job", "Nightly")!;
		first.release();
		first.stop();
		expect(gate.holder).toBe(second);
		expect(second.stopped).toBe(false);
		second.release();
		second.release();
		expect(gate.busy).toBe(false);
	});

	it("tells listeners when it is taken, stopped and released, and not after they unsubscribe", () => {
		const gate = new BusyGate();
		const seen: string[] = [];
		const off = gate.onChange(() => seen.push(gate.holder ? `${gate.holder.owner}${gate.holder.stopped ? " (stopped)" : ""}` : "free"));
		const lease = gate.acquire("job", "Nightly")!;
		lease.stop();
		lease.stop();
		lease.release();
		expect(seen).toEqual(["job", "job (stopped)", "free"]);
		off();
		gate.acquire("chat")!.release();
		expect(seen.length).toBe(3);
	});

	it("gives every lease its own signal", () => {
		const gate = new BusyGate();
		const a = gate.acquire("chat")!;
		a.stop();
		a.release();
		const b = gate.acquire("chat")!;
		expect(b.signal.aborted).toBe(false);
		expect(b.signal).not.toBe(a.signal);
	});
});
