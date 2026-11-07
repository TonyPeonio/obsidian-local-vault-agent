import type { ModelInfo, OllamaClient } from "./ollama";

/**
 * Hardware auto-tune: one short generation measures how fast the chosen model reads a
 * prompt and writes tokens at the configured context size, and `/api/ps` says how much of
 * it fits on the GPU. `recommend` turns that into advice a user can act on without knowing
 * what num_ctx or a KV cache is. Pure apart from `measure`, so the advice is unit-tested.
 */

export interface TuneMeasurement {
	model: string;
	numCtx: number;
	promptTokens: number;
	promptSeconds: number;
	genTokens: number;
	genSeconds: number;
	loadSeconds: number;
	/** From /api/ps when the model was still loaded: total bytes and the part on the GPU. */
	sizeBytes?: number;
	vramBytes?: number;
}

export interface TuneAdvice {
	/** One-line verdict. */
	headline: string;
	/** Details and reasoning, one per line. */
	lines: string[];
	/** A context size worth switching to, when the measurement suggests one. */
	suggestedNumCtx?: number;
	/** A better installed model, when there is one. */
	suggestedModel?: string;
	/** The chosen model does not support tool calling at all. */
	noTools?: boolean;
}

export const MIN_NUM_CTX = 16384;
export const MAX_NUM_CTX = 131072;

export function genTokPerSec(m: TuneMeasurement): number {
	return m.genSeconds > 0 ? m.genTokens / m.genSeconds : 0;
}

export function promptTokPerSec(m: TuneMeasurement): number {
	return m.promptSeconds > 0 ? m.promptTokens / m.promptSeconds : 0;
}

/** Share of the loaded model (weights plus context) that sits in system RAM, 0..1, or undefined when unknown. */
export function spillFraction(m: TuneMeasurement): number | undefined {
	if (!m.sizeBytes || m.vramBytes === undefined) return undefined;
	return Math.max(0, Math.min(1, (m.sizeBytes - m.vramBytes) / m.sizeBytes));
}

function gb(bytes: number): string {
	return `${(bytes / 1e9).toFixed(1)} GB`;
}

function roundCtx(n: number): number {
	// Powers of two times 16k read naturally in the settings UI.
	const steps = [16384, 24576, 32768, 49152, 65536, 98304, 131072];
	let best = steps[0];
	for (const s of steps) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
	return best;
}

export function recommend(m: TuneMeasurement, installed: ModelInfo[] = []): TuneAdvice {
	const gen = genTokPerSec(m);
	const prefill = promptTokPerSec(m);
	const spill = spillFraction(m);
	const lines: string[] = [];
	const advice: TuneAdvice = { headline: "", lines };

	lines.push(`${m.model} at a ${fmtK(m.numCtx)} context: writes ${gen.toFixed(0)} tokens/s, reads ${prefill.toFixed(0)} tokens/s${m.loadSeconds > 1 ? `, took ${m.loadSeconds.toFixed(1)} s to load` : ""}.`);
	if (spill !== undefined && m.sizeBytes) {
		lines.push(
			spill > 0.02
				? `${Math.round(spill * 100)}% of the ${gb(m.sizeBytes)} the model and its context need is in system RAM, not on the GPU.`
				: `All ${gb(m.sizeBytes)} the model and its context need fit on the GPU.`,
		);
	}
	// What that means for an agent turn: a cold step reads the whole context once; later
	// steps hit the cache, so generation speed dominates.
	const coldSeconds = prefill > 0 ? m.numCtx / prefill : 0;
	const turnSeconds = gen > 0 ? 4000 / gen : 0;
	if (coldSeconds > 0) lines.push(`A full ${fmtK(m.numCtx)} prompt takes about ${coldSeconds.toFixed(0)} s to read cold; a 40-call clean-up writes roughly 4k tokens, about ${turnSeconds.toFixed(0)} s of generation.`);

	const current = installed.find((i) => i.name === m.model);
	if (current?.capabilities && !current.capabilities.includes("tools")) {
		advice.noTools = true;
		advice.headline = `${m.model} does not support tool calling; the agent cannot work with it.`;
	}

	const tooSlow = gen > 0 && gen < 8;
	const slow = gen > 0 && gen < 20;
	if (!advice.headline) {
		if (spill !== undefined && spill > 0.02) {
			if (tooSlow) {
				advice.headline = "Too slow for agent turns: the model is spilling into system RAM. Use a smaller context or a smaller model.";
				advice.suggestedNumCtx = Math.max(MIN_NUM_CTX, roundCtx(m.numCtx / 2));
			} else {
				advice.headline = slow ? "Usable but slow: part of the model is in system RAM." : "Fast enough, although part of the model is in system RAM.";
				if (m.numCtx > MIN_NUM_CTX) advice.suggestedNumCtx = Math.max(MIN_NUM_CTX, roundCtx(m.numCtx / 2));
			}
			if (advice.suggestedNumCtx) lines.push(`A ${fmtK(advice.suggestedNumCtx)} context needs less memory and may fit on the GPU entirely; test again after changing it.`);
		} else if (spill !== undefined) {
			if (gen >= 30 && m.numCtx < MAX_NUM_CTX) {
				advice.headline = "Fully on the GPU with speed to spare: a larger context would let the agent read more per turn.";
				advice.suggestedNumCtx = Math.min(MAX_NUM_CTX, roundCtx(m.numCtx * 2));
				lines.push(`Try ${fmtK(advice.suggestedNumCtx)}; if the next test shows memory spilling into RAM or a big slowdown, come back to ${fmtK(m.numCtx)}.`);
			} else if (tooSlow) {
				advice.headline = "Fully on the GPU but slow; a smaller model would make the agent far more responsive.";
			} else {
				advice.headline = "Fully on the GPU at a good speed. Nothing to change.";
			}
		} else {
			advice.headline = tooSlow ? "Slow: under 8 tokens/s makes multi-step tasks painful." : slow ? "Usable." : "Fast enough for agent turns.";
		}
	}

	// Installed alternatives that can call tools, smallest first.
	const toolModels = installed.filter((i) => !i.capabilities || i.capabilities.includes("tools")).filter((i) => !/embed/i.test(i.name));
	if (tooSlow || advice.noTools) {
		const smaller = toolModels.filter((i) => !current || i.size < current.size).sort((a, b) => b.size - a.size);
		const pick = advice.noTools ? toolModels.sort((a, b) => b.size - a.size)[0] : smaller[0];
		if (pick && pick.name !== m.model) {
			advice.suggestedModel = pick.name;
			lines.push(`${pick.name} (${gb(pick.size)} on disk) is installed and supports tools; it should be noticeably faster.`);
		}
	}
	if (toolModels.length) {
		lines.push(`Installed models that can call tools: ${toolModels
			.slice()
			.sort((a, b) => a.size - b.size)
			.map((i) => `${i.name} (${gb(i.size)})${i.name === m.model ? " ← current" : ""}`)
			.join(", ")}.`);
	}
	return advice;
}

function fmtK(n: number): string {
	return n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
}

/** The filler is ~2k tokens with a nonce up front so Ollama cannot serve the prefill from cache. */
export function benchmarkPrompt(nonce: string): string {
	const sentence = "The quick brown fox jumps over the lazy dog while the cat watches from the warm windowsill. ";
	return `Run ${nonce}. Read the text below, then answer with the single word OK.\n\n${sentence.repeat(110)}`;
}

export async function measure(client: OllamaClient, model: string, numCtx: number, keepAlive = "10m", signal?: AbortSignal): Promise<TuneMeasurement> {
	const res = await client.chat({
		model,
		messages: [{ role: "user", content: benchmarkPrompt(String(Date.now())) }],
		think: false,
		options: { num_ctx: numCtx, temperature: 0, num_predict: 48 },
		keep_alive: keepAlive,
		signal,
	}).catch(async (err: Error) => {
		// Models without a thinking mode reject `think`; retry without it.
		if (/think/i.test(err.message)) {
			return client.chat({ model, messages: [{ role: "user", content: benchmarkPrompt(String(Date.now())) }], options: { num_ctx: numCtx, temperature: 0, num_predict: 48 }, keep_alive: keepAlive, signal });
		}
		throw err;
	});
	const m: TuneMeasurement = {
		model,
		numCtx,
		promptTokens: res.promptTokens ?? 0,
		promptSeconds: (res.promptEvalDuration ?? 0) / 1e9,
		genTokens: res.completionTokens ?? 0,
		genSeconds: (res.evalDuration ?? 0) / 1e9,
		loadSeconds: (res.loadDuration ?? 0) / 1e9,
	};
	try {
		const running = (await client.ps()).find((r) => r.name === model || r.name === `${model}:latest`);
		if (running) {
			m.sizeBytes = running.size;
			m.vramBytes = running.sizeVram;
		}
	} catch {
		// Older Ollama without /api/ps: advice is given without the memory split.
	}
	return m;
}
