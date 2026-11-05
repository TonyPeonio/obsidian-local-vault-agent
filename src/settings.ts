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
	keepAlive: string;
	/** Folder prefixes (one per line in the UI) that are never searched or indexed. */
	excludedFolders: string[];
	extraSystemPrompt: string;
}

export const DEFAULT_SETTINGS: LocalVaultAgentSettings = {
	ollamaUrl: "http://localhost:11434",
	model: "qwen3.5:9b",
	embeddingModel: "nomic-embed-text",
	semanticSearch: true,
	numCtx: 16384,
	temperature: 0.3,
	thinking: "auto",
	showThinking: true,
	maxIterations: 15,
	maxToolResultChars: 12000,
	autoApproveEdits: false,
	keepAlive: "10m",
	excludedFolders: ["templates", "Templates"],
	extraSystemPrompt: "",
};

export function isExcluded(path: string, excluded: string[]): boolean {
	const lower = path.toLowerCase();
	return excluded.some((f) => {
		const p = f.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
		return p.length > 0 && (lower === p || lower.startsWith(p + "/"));
	});
}
