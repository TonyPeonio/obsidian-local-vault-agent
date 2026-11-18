import { sameModel, type ModelInfo, type RunningModel } from "./ollama";
import { canCallTools, isEmbedding } from "./setup";

/**
 * The chat model list for the picker in the chat header and the one in settings: only models the
 * agent can use, each with its size and whether it is in memory right now. Pure: built from what
 * `/api/tags` and `/api/ps` already returned, no further requests.
 */

export interface ModelOption {
	/** The model name to store in settings. */
	value: string;
	/** What the picker shows: "qwen3.5:9b · 6.6 GB · loaded". */
	label: string;
	/** The configured model. */
	current: boolean;
	/** False for the configured model when it is not installed or cannot be used (it is still listed, so the picker shows the truth). */
	usable: boolean;
	loaded: boolean;
}

/** "6.6 GB", "640 MB"; "" when the server does not say (OpenAI-compatible servers). */
export function formatModelSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "";
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Why the agent cannot use an installed model, or null when it can (as far as the server says). */
export function unusableReason(m: ModelInfo): string | null {
	if (isEmbedding(m)) return "embedding model";
	if (!canCallTools(m)) return "cannot call tools";
	return null;
}

function loadedNote(m: ModelInfo, running: RunningModel[]): string | null {
	const r = running.find((x) => sameModel(x.name, m.name));
	if (!r) return null;
	// Part of the model in system RAM is the usual reason for a slow agent; say so where the model is chosen.
	return r.size > 0 && r.sizeVram < r.size * 0.98 ? "loaded, partly in RAM" : "loaded";
}

/**
 * The options for a chat model picker, in the server's order. Embedding models and models the
 * server says cannot call tools are left out; the configured model is always there, marked when it
 * is not installed or not usable, so the picker never shows another model as selected.
 */
export function chatModelOptions(models: ModelInfo[], running: RunningModel[], current: string): ModelOption[] {
	const out: ModelOption[] = [];
	let sawCurrent = false;
	for (const m of models) {
		const isCurrent = current.trim() !== "" && sameModel(m.name, current);
		const reason = unusableReason(m);
		if (reason && !isCurrent) continue;
		const loaded = loadedNote(m, running);
		const parts = [m.name, formatModelSize(m.size), loaded].filter((p): p is string => !!p);
		out.push({ value: m.name, label: reason ? `${parts.join(" · ")} (${reason})` : parts.join(" · "), current: isCurrent && !sawCurrent, usable: !reason, loaded: loaded !== null });
		if (isCurrent) sawCurrent = true;
	}
	if (!sawCurrent && current.trim()) out.push({ value: current, label: `${current} (not installed)`, current: true, usable: false, loaded: false });
	return out;
}
