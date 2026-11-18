/**
 * One model job at a time. A chat turn, a quiz step and a scheduled job each take the gate before
 * they call the model and give it back when they are done; whoever holds it can be stopped by
 * anyone who can see the gate. Two things used to go wrong without it: a scheduled job and a chat
 * turn could run at once (each only looked at its own flag), and Stop reached only chat turns.
 * Pure: no Obsidian imports.
 */

export type BusyOwner = "chat" | "quiz" | "job";

/** The right to use the model until `release()`. */
export interface Lease {
	readonly owner: BusyOwner;
	/** What is running, in words for the user (a job's name; empty for a chat turn). */
	readonly label: string;
	/** Aborted when the work is stopped; pass it to every model call. */
	readonly signal: AbortSignal;
	/** True once the work was stopped. Stays true after `release()`, so the code that ran can say "Stopped." */
	readonly stopped: boolean;
	stop(): void;
	/** Gives the gate back. Safe to call twice, and never frees a later holder's lease. */
	release(): void;
}

export class BusyGate {
	private current: Lease | null = null;
	private listeners = new Set<() => void>();

	/** Who holds the gate, or null when the model is free. */
	get holder(): Lease | null {
		return this.current;
	}

	get busy(): boolean {
		return this.current !== null;
	}

	/** Takes the gate, or returns null when something else is running (nothing is queued: the caller says so and stops). */
	acquire(owner: BusyOwner, label = ""): Lease | null {
		if (this.current) return null;
		const controller = new AbortController();
		const lease: Lease = {
			owner,
			label,
			signal: controller.signal,
			get stopped() {
				return controller.signal.aborted;
			},
			stop: () => {
				if (controller.signal.aborted) return;
				controller.abort();
				this.emit();
			},
			release: () => {
				if (this.current !== lease) return;
				this.current = null;
				this.emit();
			},
		};
		this.current = lease;
		this.emit();
		return lease;
	}

	/**
	 * Stops whatever is running (only when it is `owner`'s, if given). The holder keeps the gate
	 * until its own code has unwound and released it. Returns whether something was stopped.
	 */
	stop(owner?: BusyOwner): boolean {
		const lease = this.current;
		if (!lease || lease.stopped || (owner !== undefined && lease.owner !== owner)) return false;
		lease.stop();
		return true;
	}

	/** Called when the gate is taken, stopped or released. Returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const l of Array.from(this.listeners)) l();
	}
}
