import { t } from "./i18n";
import type { UsageInfo } from "./types";

/**
 * What a chat turn is doing right now, and how it went. The agent reports the start of each model
 * call, every piece of text, each tool call and, after a call, the server's own counts; from those
 * this works out the line shown while the turn runs ("Loading the model…", "Reading about 11k
 * tokens…", "Writing… about 38 tokens/s") and the one shown after it (time to the first words,
 * tokens per second, prompt size). Pure: times are passed in, nothing is read from a clock.
 */

/** Characters per token used to guess the size of text the server has not counted yet (the agent's own figure). */
const CHARS_PER_TOKEN = 3.2;
/** A rate is shown once this much has been streamed; before that it is noise. */
const MIN_RATE_MS = 500;
const MIN_RATE_TOKENS = 4;

export type Phase =
	/** The model is not in memory yet; the server is loading it. */
	| { kind: "loading" }
	/** The request is with the server and no text has come back: it is reading the prompt. `tokens` is a guess, or null. */
	| { kind: "reading"; tokens: number | null }
	| { kind: "thinking"; rate: number | null }
	| { kind: "writing"; rate: number | null }
	/** Between two model calls: tools are running (or a diff is waiting for the user). */
	| { kind: "tools" };

export interface TurnSummary {
	totalMs: number;
	/** From sending the message to the first text of any kind; null when nothing was streamed. */
	firstTokenMs: number | null;
	tokensPerSec: number | null;
	/** True when the rate was counted from the stream because the server sent no timings. */
	approximate: boolean;
	/** Size of the prompt of the last model call, as the server counted it. */
	promptTokens: number | null;
	completionTokens: number;
	/** Time the server spent loading the model, when it was not in memory. */
	loadMs: number;
	/** Model calls made. */
	steps: number;
}

export interface TurnStart {
	/** Whether the model is in memory: false shows "Loading the model…" until the first sign of life. Null when unknown. */
	loaded?: boolean | null;
	/** Tokens the conversation held after the last model call (prompt + reply), or a guess of the fixed prefix for a new chat; null when unknown. */
	contextTokens?: number | null;
	/** Length of the message being sent, with its attachments. */
	messageChars?: number;
}

/** Tokens in `pieces` streamed pieces of `chars` characters: servers send a token per piece; when the pieces are large the server batches, and the characters are the better guess. */
function streamedTokens(pieces: number, chars: number): number {
	if (pieces === 0) return 0;
	return chars / pieces > 12 ? Math.round(chars / 4) : pieces;
}

export class TurnProgress {
	private state: "waiting" | "thinking" | "writing" | "tools" = "waiting";
	private loaded: boolean | null;
	private expected: number | null;
	private firstTokenAt: number | null = null;
	private stepFirstAt: number | null = null;
	private stepPieces = 0;
	private stepChars = 0;
	private steps = 0;
	/** Totals over the model calls that have finished. */
	private streamMs = 0;
	private streamTokens = 0;
	private evalMs = 0;
	private evalTokens = 0;
	private completionTokens = 0;
	private promptTokens: number | null = null;
	private loadMs = 0;

	constructor(
		private readonly startedAt: number,
		start: TurnStart = {},
	) {
		this.loaded = start.loaded ?? null;
		const context = start.contextTokens ?? null;
		this.expected = context === null ? null : context + Math.ceil((start.messageChars ?? 0) / CHARS_PER_TOKEN);
	}

	/** The answer to "is the model in memory?" arrived. Ignored once the server has shown it is (text or counts came back). */
	setLoaded(loaded: boolean): void {
		if (this.firstTokenAt !== null || this.steps > 1 || this.promptTokens !== null) return;
		this.loaded = loaded;
	}

	/** A model call was sent. */
	stepStart(): void {
		this.steps++;
		this.state = "waiting";
		this.stepFirstAt = null;
		this.stepPieces = 0;
		this.stepChars = 0;
	}

	/** A piece of the reply (or of the model's thinking) arrived. */
	delta(now: number, kind: "thinking" | "content", chars: number): void {
		if (this.firstTokenAt === null) this.firstTokenAt = now;
		if (this.stepFirstAt === null) this.stepFirstAt = now;
		this.loaded = true;
		this.state = kind === "thinking" ? "thinking" : "writing";
		this.stepPieces++;
		this.stepChars += chars;
	}

	/** The model call ended; tools run next, or the turn is over. */
	stepDone(now: number): void {
		if (this.stepFirstAt !== null) {
			this.streamMs += now - this.stepFirstAt;
			this.streamTokens += streamedTokens(this.stepPieces, this.stepChars);
		}
		this.stepFirstAt = null;
		this.state = "tools";
	}

	/** The server's counts for the model call that just ended. */
	usage(u: UsageInfo): void {
		this.loaded = true;
		this.promptTokens = u.promptTokens;
		this.completionTokens += u.completionTokens;
		if (u.evalMs !== undefined && u.evalMs > 0) {
			this.evalMs += u.evalMs;
			this.evalTokens += u.completionTokens;
		}
		this.loadMs += u.loadMs ?? 0;
		this.expected = u.promptTokens + u.completionTokens;
	}

	/** Text was added to the conversation (a tool's result, attached notes) that the next model call has to read. */
	added(chars: number): void {
		if (this.expected !== null && chars > 0) this.expected += Math.ceil(chars / CHARS_PER_TOKEN);
	}

	phase(now: number): Phase {
		if (this.state === "tools") return { kind: "tools" };
		if (this.state === "waiting") return this.loaded === false ? { kind: "loading" } : { kind: "reading", tokens: this.expected };
		const elapsed = this.stepFirstAt === null ? 0 : now - this.stepFirstAt;
		const tokens = streamedTokens(this.stepPieces, this.stepChars);
		const rate = elapsed >= MIN_RATE_MS && tokens >= MIN_RATE_TOKENS ? tokens / (elapsed / 1000) : null;
		return { kind: this.state, rate };
	}

	summary(now: number): TurnSummary {
		let tokensPerSec: number | null = null;
		let approximate = false;
		if (this.evalMs > 0 && this.evalTokens > 0) tokensPerSec = this.evalTokens / (this.evalMs / 1000);
		else {
			// No timings from the server (OpenAI-compatible ones send none): its token count, or the
			// pieces that were streamed, over the time text was arriving.
			const tokens = this.completionTokens > 0 ? this.completionTokens : this.streamTokens;
			if (this.streamMs >= MIN_RATE_MS && tokens >= MIN_RATE_TOKENS) {
				tokensPerSec = tokens / (this.streamMs / 1000);
				approximate = true;
			}
		}
		return {
			totalMs: now - this.startedAt,
			firstTokenMs: this.firstTokenAt === null ? null : this.firstTokenAt - this.startedAt,
			tokensPerSec,
			approximate,
			promptTokens: this.promptTokens,
			completionTokens: this.completionTokens > 0 ? this.completionTokens : this.streamTokens,
			loadMs: this.loadMs,
			steps: this.steps,
		};
	}
}

/** "850", "1.2k", "11k". */
export function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n));
}

/** "0.8 s", "14 s", "1 min 12 s". */
export function formatDuration(ms: number): string {
	const secs = Math.max(0, ms) / 1000;
	if (secs < 9.95) return `${secs.toFixed(1)} s`;
	if (secs < 59.5) return `${Math.round(secs)} s`;
	const whole = Math.round(secs);
	const rest = whole % 60;
	return rest ? `${Math.floor(whole / 60)} min ${rest} s` : `${Math.floor(whole / 60)} min`;
}

function formatRate(rate: number): string {
	return rate < 9.95 ? rate.toFixed(1) : String(Math.round(rate));
}

/** The words for what the turn is doing, for the status line under the message box. */
export function phaseText(phase: Phase): string {
	switch (phase.kind) {
		case "loading":
			return t("view.phase.loading");
		case "reading":
			return phase.tokens === null ? t("view.phase.reading") : t("view.phase.readingTokens", { tokens: formatTokens(phase.tokens) });
		case "thinking":
			return phase.rate === null ? t("view.phase.thinking") : t("view.phase.thinkingRate", { rate: formatRate(phase.rate) });
		case "writing":
			return phase.rate === null ? t("view.phase.writing") : t("view.phase.writingRate", { rate: formatRate(phase.rate) });
		case "tools":
			return t("view.phase.tools");
	}
}

/** The line under a finished reply: how long it took and how fast the model was. Empty when nothing is known beyond the time. */
export function summaryText(s: TurnSummary): string {
	if (s.firstTokenMs === null && s.tokensPerSec === null && s.promptTokens === null) return "";
	const parts = [formatDuration(s.totalMs)];
	if (s.firstTokenMs !== null) parts.push(t("view.stats.firstToken", { time: formatDuration(s.firstTokenMs) }));
	if (s.tokensPerSec !== null) parts.push(t(s.approximate ? "view.stats.rateAbout" : "view.stats.rate", { rate: formatRate(s.tokensPerSec) }));
	if (s.promptTokens !== null) parts.push(t("view.stats.prompt", { tokens: formatTokens(s.promptTokens) }));
	if (s.loadMs >= 1000) parts.push(t("view.stats.load", { time: formatDuration(s.loadMs) }));
	return parts.join(" · ");
}

/** A turn this long that ends while the user is in another application gets a notice. */
export const NOTIFY_AFTER_MS = 30_000;

export function shouldNotify(totalMs: number, focused: boolean): boolean {
	return !focused && totalMs > NOTIFY_AFTER_MS;
}
