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
}

export const DEFAULT_SETTINGS: LocalVaultAgentSettings = {
	ollamaUrl: "http://localhost:11434",
	model: "qwen3.5:9b",
	embeddingModel: "nomic-embed-text",
	semanticSearch: true,
	numCtx: 32768,
	temperature: 0.3,
	thinking: "auto",
	showThinking: true,
	maxIterations: 60,
	maxToolResultChars: 12000,
	autoApproveEdits: false,
	autoContinue: true,
	keepAlive: "10m",
	excludedFolders: ["templates", "Templates"],
	extraSystemPrompt: "",
	conventionsNote: "AGENT.md",
	gists: true,
};

export function isExcluded(path: string, excluded: string[]): boolean {
	const lower = path.toLowerCase();
	return excluded.some((f) => {
		const p = f.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
		return p.length > 0 && (lower === p || lower.startsWith(p + "/"));
	});
}
