/**
 * A small in-memory log of what the plugin did and what went wrong (the last 200 lines), for the
 * "Report a problem" dialog. Nothing is written to disk or sent anywhere; it is gone on restart.
 * Pure: no Obsidian imports.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
	time: number;
	level: LogLevel;
	message: string;
}

export class RingLog {
	private entries: LogEntry[] = [];

	constructor(
		private capacity = 200,
		private now: () => number = () => Date.now(),
	) {}

	add(level: LogLevel, message: string): void {
		this.entries.push({ time: this.now(), level, message: message.replace(/\s+/g, " ").trim().slice(0, 500) });
		if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
	}

	info(message: string): void {
		this.add("info", message);
	}

	warn(message: string): void {
		this.add("warn", message);
	}

	error(message: string | Error): void {
		this.add("error", message instanceof Error ? `${message.name}: ${message.message}` : message);
	}

	/** The last `n` entries, oldest first. */
	tail(n = 50): LogEntry[] {
		return this.entries.slice(-n);
	}

	/** The most recent error, if any. */
	lastError(): LogEntry | undefined {
		for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].level === "error") return this.entries[i];
		return undefined;
	}

	get size(): number {
		return this.entries.length;
	}
}

/** The plugin-wide log. */
export const log = new RingLog();

export function formatLogLine(e: LogEntry): string {
	return `${new Date(e.time).toISOString().slice(11, 19)} ${e.level.toUpperCase().padEnd(5)} ${e.message}`;
}
