import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { looksLikeVaultQuestion } from "../src/agent";
import LocalVaultAgentPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";

/**
 * Three numbers the README and the release notes state. Each test fails when the code's number
 * changes, and names the sentence that then has to change with it.
 */

const readme = readFileSync("README.md", "utf8").replace(/\s+/g, " ");
const notes = readFileSync("release-notes/0.9.0.md", "utf8").replace(/\s+/g, " ");

describe("60 steps per message by default", () => {
	it("is the default of the setting", () => {
		expect(DEFAULT_SETTINGS.maxIterations).toBe(60);
	});

	it("is what the README says", () => {
		expect(readme).toContain("**Max tool calls per message** — default 60");
	});
});

describe("the warm-up runs at most once in four minutes", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function standIn(warmUp: boolean) {
		const calls = { warm: 0, context: 0 };
		const p = Object.assign(Object.create(LocalVaultAgentPlugin.prototype) as LocalVaultAgentPlugin, {
			busy: { busy: false, holder: null },
			jobRunning: false,
			lastWarm: 0,
			settings: { warmUp, model: "fake-model" },
			agent: { warm: async () => void calls.warm++ },
			client: { loadedContext: async () => void calls.context++ },
		});
		return { p, calls };
	}

	it("a second focus of the chat box inside four minutes does not warm the model again; one at four minutes does", () => {
		vi.useFakeTimers();
		const t0 = new Date("2026-11-18T10:00:00").getTime();
		vi.setSystemTime(t0);
		const { p, calls } = standIn(true);
		p.warmModel();
		expect(calls.warm).toBe(1);
		vi.setSystemTime(t0 + 1000);
		p.warmModel();
		vi.setSystemTime(t0 + 4 * 60_000 - 1);
		p.warmModel();
		expect(calls.warm).toBe(1);
		vi.setSystemTime(t0 + 4 * 60_000);
		p.warmModel();
		expect(calls.warm).toBe(2);
		vi.setSystemTime(t0 + 8 * 60_000 - 1);
		p.warmModel();
		expect(calls.warm).toBe(2);
	});

	it("the same limit holds for the question to the server when the warm-up is switched off", () => {
		vi.useFakeTimers();
		const t0 = new Date("2026-11-18T10:00:00").getTime();
		vi.setSystemTime(t0);
		const { p, calls } = standIn(false);
		p.warmModel();
		vi.setSystemTime(t0 + 4 * 60_000 - 1);
		p.warmModel();
		expect(calls).toEqual({ warm: 0, context: 1 });
		vi.setSystemTime(t0 + 4 * 60_000);
		p.warmModel();
		expect(calls).toEqual({ warm: 0, context: 2 });
	});

	it("is what the README and the release notes say", () => {
		expect(readme).toContain("at most once in four minutes");
		expect(notes).toContain("at most once in four minutes");
	});
});

describe("the search before the first reply is skipped for a message of more than one line or 400 characters", () => {
	/** A question of exactly `n` characters on one line. */
	const question = (n: number) => {
		const start = "What did I decide about the gantry belt tension";
		return `${start} ${"x".repeat(n - start.length - 2)}?`;
	};

	it("400 characters are searched for, 401 are not", () => {
		expect(question(400)).toHaveLength(400);
		expect(looksLikeVaultQuestion(question(400))).toBe(true);
		expect(looksLikeVaultQuestion(question(401))).toBe(false);
		// Spaces around the message do not count.
		expect(looksLikeVaultQuestion(`  ${question(400)}  `)).toBe(true);
	});

	it("one line is searched for, two lines are not", () => {
		expect(looksLikeVaultQuestion("What did I decide about the gantry? And about the belt?")).toBe(true);
		expect(looksLikeVaultQuestion("What did I decide about the gantry?\nAnd about the belt?")).toBe(false);
		// A line break at the end is not a second line.
		expect(looksLikeVaultQuestion("What did I decide about the gantry?\n")).toBe(true);
	});

	it("is what the README and the release notes say", () => {
		expect(readme).toContain("messages of more than one line");
		expect(notes).toContain("messages of more than one line or more than 400 characters");
	});
});
