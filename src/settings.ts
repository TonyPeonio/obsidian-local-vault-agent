export interface LocalVaultAgentSettings {
	ollamaUrl: string;
	model: string;
	embeddingModel: string;
	semanticSearch: boolean;
	numCtx: number;
	temperature: number;
	/** "auto" uses the model default, "on"/"off" force it. */
	thinking: "auto" | "on" | "off";
	showThinking: boolean;
	maxIterations: number;
	maxToolResultChars: number;
	autoApproveEdits: boolean;
	/** When the model stops to ask "shall I proceed?", answer yes for the user (a few times per turn). */
	autoContinue: boolean;
	keepAlive: string;
	/** Folder prefixes (one per line in the UI) that are never searched or indexed. */
	excludedFolders: string[];
	extraSystemPrompt: string;
	/** A note whose contents are always in the system prompt (vault conventions), like CLAUDE.md. */
	conventionsNote: string;
	/** Generate one-line gists of every note with the chat model (background) for the outline. */
	gists: boolean;
	/** Bumped when a default changes in a way existing settings should pick up. */
	settingsVersion: number;
	/** "Process my daily notes": the inbox heading inside each daily note (without '#'). */
	dailyInboxHeading: string;
	/** "Process my daily notes": folder for the compiled topic notes ("" = vault root). */
	dailyTopicsFolder: string;
	/** "Process my daily notes": replace a compiled inbox with a link to its topic note. */
	dailyMoveItems: boolean;
}

/** The current settings schema; `migrateSettings` brings older saved data up to it. */
export const SETTINGS_VERSION = 4;

/**
 * Sampling sent with every chat request besides temperature. The Qwen3 model card warns that
 * greedy or near-greedy decoding "can lead to performance degradation and endless repetitions"
 * and recommends top_p 0.8–0.95, top_k 20 and a presence penalty of 0–2 against repetition;
 * a repeated tool call forty times over is exactly that failure. The penalty is kept low
 * because tool-call JSON legitimately repeats keys.
 */
export const SAMPLING = { top_p: 0.9, top_k: 20, presence_penalty: 0.5 } as const;

export const DEFAULT_SETTINGS: LocalVaultAgentSettings = {
	ollamaUrl: "http://localhost:11434",
	model: "qwen3.5:9b",
	embeddingModel: "nomic-embed-text",
	semanticSearch: true,
	numCtx: 32768,
	temperature: 0.6,
	// Off by default since 0.5.0: on the benchmark vault qwen3.5:9b passed as many checks without
	// thinking (92–94/96) as with it (90–91/96) in a third of the time and with fewer tool calls.
	thinking: "off",
	showThinking: true,
	maxIterations: 60,
	maxToolResultChars: 12000,
	autoApproveEdits: false,
	autoContinue: true,
	keepAlive: "10m",
	excludedFolders: ["templates", "Templates"],
	extraSystemPrompt: "",
	conventionsNote: "AGENT.md",
	// Off by default since 0.5.3: the benchmark scored the same with gists off (114 vs 113), and the
	// pass runs the chat model once per note, which is an hour's work for a large vault on a modest GPU.
	gists: false,
	settingsVersion: SETTINGS_VERSION,
	dailyInboxHeading: "Capture",
	dailyTopicsFolder: "Topics",
	dailyMoveItems: true,
};

/**
 * Saved settings from an older version, filled in with current defaults. Version 1 (no
 * `settingsVersion`) defaulted temperature to 0.3, which is close enough to greedy to make
 * small models loop; a user still on that default moves to the new one, a changed value stays.
 * Versions 1 and 2 defaulted thinking to "auto" (on, for Qwen3); a user still on that default
 * moves to "off", which benchmarked as fast and as accurate. "On" chosen explicitly stays.
 * Version 4 turns gists off (same benchmark score, an hour of GPU work on a large vault) and
 * brings a context window above 32k back to 32k once: the benchmark scored the same at 64k, the
 * history sent to the model is capped at the 32k budget anyway, and the extra KV cache is what
 * forces Ollama to evict the embedding model on a 12 GB card. Both can be set again.
 */
export function migrateSettings(data: Partial<LocalVaultAgentSettings> | null): LocalVaultAgentSettings {
	const saved = data ?? {};
	const version = typeof saved.settingsVersion === "number" ? saved.settingsVersion : 1;
	const settings: LocalVaultAgentSettings = { ...DEFAULT_SETTINGS, ...saved };
	if (version < 2 && saved.temperature === 0.3) settings.temperature = DEFAULT_SETTINGS.temperature;
	if (version < 3 && saved.thinking === "auto") settings.thinking = "off";
	if (version < 4) {
		if (saved.gists === true) settings.gists = false;
		if (typeof saved.numCtx === "number" && saved.numCtx > 32768) settings.numCtx = 32768;
	}
	settings.settingsVersion = SETTINGS_VERSION;
	return settings;
}

export function isExcluded(path: string, excluded: string[]): boolean {
	const lower = path.toLowerCase();
	return excluded.some((f) => {
		const p = f.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
		return p.length > 0 && (lower === p || lower.startsWith(p + "/"));
	});
}
