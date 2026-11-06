/**
 * Shared types for the agent, the Ollama client and the tool layer.
 * This file deliberately has no Obsidian imports so the core stays unit-testable.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
	id?: string;
	function: {
		name: string;
		arguments: Record<string, unknown>;
	};
}

export interface ChatMessage {
	role: Role;
	content: string;
	/** Reasoning tokens from "thinking" models (Qwen3, DeepSeek-R1, ...). */
	thinking?: string;
	tool_calls?: ToolCall[];
	/** For role === "tool": the name of the tool that produced this result. */
	tool_name?: string;
}

/** JSON-schema subset that Ollama accepts for tool parameters. */
export interface JsonSchema {
	type: "object";
	properties: Record<
		string,
		{
			type: "string" | "number" | "integer" | "boolean" | "array";
			description: string;
			enum?: string[];
			items?: { type: string };
		}
	>;
	required?: string[];
}

export interface OllamaToolSpec {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: JsonSchema;
	};
}

export interface NoteInfo {
	/** Vault-relative path including the `.md` extension. */
	path: string;
	/** File name without extension. */
	basename: string;
	/** Parent folder path, "" for the vault root. */
	folder: string;
	mtime: number;
	ctime: number;
	size: number;
}

export interface NoteMetadata {
	tags: string[];
	links: string[];
	backlinks: string[];
	headings: string[];
	frontmatter: Record<string, unknown>;
}

/**
 * Everything the tools need from the vault. The Obsidian implementation lives in
 * `obsidian-vault.ts`; tests use an in-memory fake.
 */
export interface VaultAccess {
	listNotes(): NoteInfo[];
	/** Resolve a user/model-supplied path or note name to an existing note path, or null. */
	resolve(pathOrName: string): string | null;
	exists(path: string): boolean;
	read(path: string): Promise<string>;
	create(path: string, content: string): Promise<void>;
	modify(path: string, content: string): Promise<void>;
	/** Move a note to the trash (never a permanent delete). */
	trash(path: string): Promise<void>;
	getMetadata(path: string): NoteMetadata;
	getActiveNotePath(): string | null;
	getSelection(): string | null;
}

export interface SearchHit {
	path: string;
	score: number;
	snippet: string;
	heading?: string;
}

export interface ApprovalRequest {
	tool: string;
	path: string;
	/** Existing content ("" for a new note). */
	before: string;
	/** Proposed content. */
	after: string;
	summary: string;
}

export type ApprovalDecision = "approve" | "reject" | "approve-all";

export interface ToolContext {
	vault: VaultAccess;
	search: (query: string, limit: number) => Promise<SearchHit[]>;
	/** Ask the user to approve a mutation. Resolves to the decision. */
	approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
	maxResultChars: number;
	/** The vault's configuration folder (Obsidian's `Vault.configDir`); never written to. */
	configDir?: string;
	signal?: AbortSignal;
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: JsonSchema;
	/** True when the tool writes to the vault and therefore needs approval. */
	mutates: boolean;
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface AgentCallbacks {
	onAssistantStart?(): void;
	onAssistantDelta?(content: string): void;
	onThinkingDelta?(thinking: string): void;
	onAssistantDone?(message: ChatMessage): void;
	onToolStart?(call: ToolCall): void;
	onToolDone?(call: ToolCall, result: string, ok: boolean): void;
	onStatus?(text: string): void;
	/** The agent answered the model's "shall I proceed?" for the user; `text` is the injected user turn. */
	onAutoContinue?(text: string): void;
}
