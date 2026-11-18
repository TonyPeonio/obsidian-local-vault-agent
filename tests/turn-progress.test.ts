import { describe, expect, it } from "vitest";
import { TurnProgress, formatDuration, formatTokens, phaseText, shouldNotify, summaryText } from "../src/turn-progress";

/** Streams `n` one-token pieces, one every `everyMs`, starting at `from`. Returns the time of the last piece. */
function write(p: TurnProgress, from: number, n: number, everyMs: number, kind: "thinking" | "content" = "content"): number {
	let at = from;
	for (let i = 0; i < n; i++) {
		at = from + i * everyMs;
		p.delta(at, kind, 5);
	}
	return at;
}

describe("TurnProgress while a turn runs", () => {
	it("says the model is loading until the server shows a sign of life", () => {
		const p = new TurnProgress(0, { loaded: false });
		p.stepStart();
		expect(phaseText(p.phase(1000))).toBe("Loading the model…");
		p.setLoaded(true);
		expect(phaseText(p.phase(2000))).toBe("Reading the prompt…");
	});

	it("does not claim to know whether the model is loaded when nobody said", () => {
		const p = new TurnProgress(0);
		p.stepStart();
		expect(p.phase(500)).toEqual({ kind: "reading", tokens: null });
	});

	it("stops saying 'loading' at the first text even if nobody reported the model as loaded", () => {
		const p = new TurnProgress(0, { loaded: false });
		p.stepStart();
		p.delta(70_000, "content", 4);
		expect(p.phase(70_100).kind).toBe("writing");
		p.stepDone(71_000);
		p.stepStart();
		expect(p.phase(71_100).kind).toBe("reading");
	});

	it("ignores a late 'not loaded' answer once text or counts have come back", () => {
		const p = new TurnProgress(0);
		p.stepStart();
		p.delta(100, "content", 4);
		p.setLoaded(false);
		p.stepDone(200);
		p.stepStart();
		expect(p.phase(300).kind).toBe("reading");
	});

	it("guesses the prompt from the last call's counts plus what was added since", () => {
		// 11,000 tokens after the last reply, and a 320-character message: about 100 tokens more.
		const p = new TurnProgress(0, { loaded: true, contextTokens: 11_000, messageChars: 320 });
		p.stepStart();
		expect(p.phase(100)).toEqual({ kind: "reading", tokens: 11_100 });
		expect(phaseText(p.phase(100))).toBe("Reading about 11k tokens…");
		p.stepDone(900);
		p.usage({ promptTokens: 11_090, completionTokens: 30, numCtx: 32768 });
		// A tool returned 6,400 characters: about 2,000 tokens for the next call to read.
		p.added(6400);
		p.stepStart();
		expect(p.phase(1000)).toEqual({ kind: "reading", tokens: 13_120 });
	});

	it("shows a writing rate once enough has arrived, counted from the first piece of the call", () => {
		const p = new TurnProgress(0, { loaded: true });
		p.stepStart();
		p.delta(3000, "content", 5);
		expect(phaseText(p.phase(3050))).toBe("Writing…");
		// 40 pieces, one every 25 ms: 40 tokens in the first second.
		write(p, 3025, 39, 25);
		expect(phaseText(p.phase(4000))).toBe("Writing… about 40 tokens/s");
	});

	it("says thinking while the model reasons, then writing", () => {
		const p = new TurnProgress(0, { loaded: true });
		p.stepStart();
		write(p, 1000, 13, 100, "thinking");
		expect(phaseText(p.phase(3000))).toBe("Thinking… about 6.5 tokens/s");
		p.delta(3000, "content", 4);
		expect(p.phase(3100).kind).toBe("writing");
	});

	it("counts by characters when the server sends text in large batches", () => {
		const p = new TurnProgress(0, { loaded: true });
		p.stepStart();
		// Five pieces of 80 characters in two seconds: 100 tokens' worth, not five.
		for (let i = 0; i < 5; i++) p.delta(1000 + i * 500, "content", 80);
		const phase = p.phase(3000);
		expect(phase).toEqual({ kind: "writing", rate: 50 });
	});

	it("is 'working' between model calls", () => {
		const p = new TurnProgress(0, { loaded: true });
		p.stepStart();
		p.stepDone(500);
		expect(phaseText(p.phase(600))).toBe("Working…");
	});
});

describe("TurnProgress after a turn", () => {
	it("reports the wait for the first words, the server's own rate and the last prompt size", () => {
		const p = new TurnProgress(10_000, { loaded: false });
		// Call 1: a tool call, nothing streamed.
		p.stepStart();
		p.stepDone(15_000);
		p.usage({ promptTokens: 10_700, completionTokens: 30, numCtx: 32768, promptEvalMs: 2900, evalMs: 800, loadMs: 4200 });
		p.added(3000);
		// Call 2: the answer.
		p.stepStart();
		const last = write(p, 16_400, 120, 25);
		p.stepDone(last);
		p.usage({ promptTokens: 11_650, completionTokens: 120, numCtx: 32768, promptEvalMs: 300, evalMs: 3000, loadMs: 0 });
		const s = p.summary(19_500);
		expect(s).toMatchObject({ totalMs: 9500, firstTokenMs: 6400, approximate: false, promptTokens: 11_650, completionTokens: 150, loadMs: 4200, steps: 2 });
		// 150 tokens in 3.8 s of generation.
		expect(s.tokensPerSec).toBeCloseTo(39.47, 1);
		expect(summaryText(s)).toBe("9.5 s · first words after 6.4 s · 39 tokens/s · 12k prompt tokens · model loaded in 4.2 s");
	});

	it("falls back to the stream's own count when the server sends no timings", () => {
		const p = new TurnProgress(0);
		p.stepStart();
		const last = write(p, 1000, 61, 50);
		p.stepDone(last);
		// An OpenAI-compatible server: token counts, no durations.
		p.usage({ promptTokens: 900, completionTokens: 60, numCtx: 8192 });
		const s = p.summary(4100);
		expect(s.approximate).toBe(true);
		expect(s.tokensPerSec).toBeCloseTo(20, 5);
		expect(summaryText(s)).toBe("4.1 s · first words after 1.0 s · about 20 tokens/s · 900 prompt tokens");
	});

	it("counts streamed pieces when the server reports nothing at all", () => {
		const p = new TurnProgress(0);
		p.stepStart();
		const last = write(p, 500, 31, 100);
		p.stepDone(last);
		const s = p.summary(3600);
		expect(s).toMatchObject({ approximate: true, promptTokens: null, completionTokens: 31 });
		expect(summaryText(s)).toBe("3.6 s · first words after 0.5 s · about 10 tokens/s");
	});

	it("has nothing to say about a turn that made no model call it could measure", () => {
		const p = new TurnProgress(0);
		p.stepStart();
		expect(summaryText(p.summary(800))).toBe("");
	});

	it("leaves out a load time under a second", () => {
		const p = new TurnProgress(0);
		p.stepStart();
		p.stepDone(900);
		p.usage({ promptTokens: 500, completionTokens: 10, numCtx: 8192, evalMs: 400, loadMs: 7 });
		expect(summaryText(p.summary(1000))).toBe("1.0 s · 25 tokens/s · 500 prompt tokens");
	});
});

describe("formatting and the finished-turn notice", () => {
	it("formats durations and token counts compactly", () => {
		expect(formatDuration(840)).toBe("0.8 s");
		expect(formatDuration(9940)).toBe("9.9 s");
		expect(formatDuration(9960)).toBe("10 s");
		expect(formatDuration(59_400)).toBe("59 s");
		expect(formatDuration(59_600)).toBe("1 min");
		expect(formatDuration(72_000)).toBe("1 min 12 s");
		expect(formatTokens(850)).toBe("850");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(11_650)).toBe("12k");
	});

	it("notifies only for a turn over 30 s that ends while Obsidian is not focused", () => {
		expect(shouldNotify(45_000, false)).toBe(true);
		expect(shouldNotify(45_000, true)).toBe(false);
		expect(shouldNotify(30_000, false)).toBe(false);
		expect(shouldNotify(12_000, false)).toBe(false);
	});
});
