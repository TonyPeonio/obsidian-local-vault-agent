import { sameModel, type ModelInfo } from "./ollama";

/**
 * The first-run checklist: is the model server there, is there a chat model that can call tools,
 * an embedding model, a built index. Each step says what is wrong in one line and which fix to
 * offer. Pure: the dialog fills it in with live data.
 */

export type StepState = "ok" | "missing" | "warn" | "unknown";

export interface SetupStep {
	id: "server" | "chat" | "embed" | "index";
	state: StepState;
	detail: string;
	/** The fix to offer: download a model, switch to an installed one, build the index, open settings. */
	fix?: { kind: "pull"; model: string } | { kind: "use"; model: string; role: "chat" | "embed" } | { kind: "index" } | { kind: "settings" };
}

export type MachineTier = "24" | "12" | "8" | "cpu";

/** The chat model the README recommends for each machine (benchmarked on qwen3.5). */
export const RECOMMENDED: Record<MachineTier, string> = {
	"24": "qwen3.5:35b-a3b",
	"12": "qwen3.5:9b",
	"8": "qwen3.5:4b",
	cpu: "qwen3.5:4b",
};
export const RECOMMENDED_EMBED = "nomic-embed-text";

/** A first guess at the tier from the browser's coarse memory hint (GB, capped at 8 by browsers). */
export function guessTier(deviceMemoryGb: number | undefined): MachineTier {
	if (deviceMemoryGb === undefined) return "12";
	return deviceMemoryGb >= 8 ? "12" : "8";
}

/** Models that are probably embedding models (by capability, else by name). */
function isEmbedding(m: ModelInfo): boolean {
	return m.capabilities ? m.capabilities.includes("embedding") && !m.capabilities.includes("completion") : /embed|bge|e5-|gte-|minilm/i.test(m.name);
}

/** Models that can call tools (by capability when the server says, else every non-embedding model). */
function canCallTools(m: ModelInfo): boolean {
	return m.capabilities ? m.capabilities.includes("tools") : !isEmbedding(m);
}

export interface SetupInput {
	provider: "ollama" | "openai";
	/** null when the server could not be reached. */
	models: ModelInfo[] | null;
	serverError?: string;
	chatModel: string;
	embeddingModel: string;
	semanticSearch: boolean;
	index: { indexedFiles: number; building: boolean; pending: number; lastError?: string | null };
	notes: number;
	tier: MachineTier;
}

export function evaluateSetup(i: SetupInput): SetupStep[] {
	const steps: SetupStep[] = [];
	const pullable = i.provider === "ollama";
	if (!i.models) {
		steps.push({ id: "server", state: "missing", detail: i.provider === "ollama" ? `Ollama is not reachable${i.serverError ? ` (${i.serverError})` : ""}. Install it from ollama.com and start it, or fix the URL in settings.` : `The server is not reachable${i.serverError ? ` (${i.serverError})` : ""}. Start it (LM Studio: enable the local server) or fix the URL in settings.`, fix: { kind: "settings" } });
		steps.push({ id: "chat", state: "unknown", detail: "Waiting for the server." });
		steps.push({ id: "embed", state: "unknown", detail: "Waiting for the server." });
		steps.push({ id: "index", state: "unknown", detail: "Waiting for the server." });
		return steps;
	}
	steps.push({ id: "server", state: "ok", detail: `${i.models.length} model${i.models.length === 1 ? "" : "s"} available.` });

	const chat = i.models.find((m) => sameModel(m.name, i.chatModel));
	const recommended = RECOMMENDED[i.tier];
	const toolModels = i.models.filter(canCallTools);
	if (chat && canCallTools(chat)) steps.push({ id: "chat", state: "ok", detail: `${chat.name} is installed and can call tools.` });
	else if (chat) {
		const alt = toolModels[0];
		steps.push({ id: "chat", state: "missing", detail: `${chat.name} cannot call tools, which the agent needs.`, fix: alt ? { kind: "use", model: alt.name, role: "chat" } : pullable ? { kind: "pull", model: recommended } : { kind: "settings" } });
	} else {
		const installedRec = i.models.find((m) => sameModel(m.name, recommended));
		steps.push({
			id: "chat",
			state: "missing",
			detail: `${i.chatModel} is not installed.`,
			fix: installedRec ? { kind: "use", model: installedRec.name, role: "chat" } : pullable ? { kind: "pull", model: recommended } : toolModels[0] ? { kind: "use", model: toolModels[0].name, role: "chat" } : { kind: "settings" },
		});
	}

	if (!i.semanticSearch) steps.push({ id: "embed", state: "warn", detail: "Semantic search is off; keyword search only.", fix: { kind: "settings" } });
	else if (i.models.some((m) => sameModel(m.name, i.embeddingModel))) steps.push({ id: "embed", state: "ok", detail: `${i.embeddingModel} is installed.` });
	else {
		const other = i.models.find(isEmbedding);
		steps.push({ id: "embed", state: "missing", detail: `${i.embeddingModel} is not installed; search falls back to keywords.`, fix: pullable ? { kind: "pull", model: i.embeddingModel || RECOMMENDED_EMBED } : other ? { kind: "use", model: other.name, role: "embed" } : { kind: "settings" } });
	}

	if (!i.semanticSearch) steps.push({ id: "index", state: "warn", detail: "No index without semantic search." });
	else if (i.index.lastError) steps.push({ id: "index", state: "missing", detail: `Index error: ${i.index.lastError}`, fix: { kind: "index" } });
	else if (i.index.building) steps.push({ id: "index", state: "warn", detail: `Indexing… ${i.index.indexedFiles} of ${i.index.indexedFiles + i.index.pending} notes.` });
	else if (i.index.indexedFiles === 0 && i.notes > 0) steps.push({ id: "index", state: "missing", detail: `None of your ${i.notes} notes are indexed yet.`, fix: { kind: "index" } });
	else steps.push({ id: "index", state: "ok", detail: `${i.index.indexedFiles} notes indexed.` });
	return steps;
}

export function setupComplete(steps: SetupStep[]): boolean {
	return steps.every((s) => s.state === "ok" || s.state === "warn");
}

/** "1.2 GB of 6.6 GB (18%)" from a pull's progress. */
export function formatProgress(fraction: number | null, status: string): string {
	return fraction === null ? status || "starting…" : `${Math.round(fraction * 100)}%`;
}
