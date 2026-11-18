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
	/** For role === "tool": the id of the call it answers (OpenAI-compatible servers need it). */
	tool_call_id?: string;
	/** For role === "user": the date, open note and daily note when the message was sent; appended to the content for the model, not shown in the chat. */
	context?: string;
	/** For role === "user": a message the agent sent itself to keep the model going ("Yes, continue"); it does not start a new turn. */
	nudge?: boolean;
	/** For role === "tool": the agent's repeated-call cache key for this result (not sent to the model). */
	cacheKey?: string;
	/** Base64 images sent with the message (vision models only; never saved with the chat). */
	images?: string[];
	/** For role === "tool": false when the call failed, was refused or skipped. Written by the chat view so a restored chat draws the card as it was; not sent to the model. */
	ok?: boolean;
	/** For role === "tool": ids in the change history of the writes the call made (the Undo buttons of a restored chat); not sent to the model. */
	changes?: number[];
}

/**
 * The one argument of a tool call whose arguments were not valid JSON (cut off at the length
 * limit, or malformed): the start of what the model sent. The agent answers such a call with
 * "your JSON was invalid", where an empty object made every tool say "missing required argument".
 */
export const INVALID_ARGUMENTS = "__invalid_json";

/** JSON-schema subset that Ollama accepts for tool parameters. */
export interface JsonSchema {
	type: "object";
	properties: Record<
		string,
		{
			type: "string" | "number" | "integer" | "boolean" | "array";
			description: string;
			enum?: string[];
			items?: { type: string; properties?: Record<string, { type: string; description: string }>; required?: string[] };
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

/** A non-markdown file in the vault (recording, image, PDF, …). */
export interface FileInfo extends NoteInfo {
	/** Lower-case extension without the dot, e.g. "webm". */
	extension: string;
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
	/** Non-markdown files (attachments), excluding excluded folders. */
	listAttachments(): FileInfo[];
	/** Resolve a path to an existing file of any type (exact path, forward slashes), or null. */
	resolveFile(path: string): string | null;
	/** Move a note or attachment to the trash (never a permanent delete). */
	trash(path: string): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer>;
	createBinary(path: string, data: ArrayBuffer): Promise<void>;
	/** Move or rename a note or attachment; links pointing at it are updated. */
	rename(path: string, newPath: string): Promise<void>;
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

/** One indexed section of a note, returned verbatim by passage search. */
export interface Passage {
	path: string;
	/** The heading the passage sits directly under. */
	heading: string;
	/** The heading with the headings above it ("2026-09-10 › Summary"); what is shown to the model. */
	crumb?: string;
	text: string;
	/** Cosine similarity between the question and the passage. */
	score: number;
	/** How many of the question's words the passage contains, when word matching ran and found it. */
	words?: { matched: number; terms: number };
}

export interface UsageInfo {
	promptTokens: number;
	completionTokens: number;
	numCtx: number;
	/** Milliseconds Ollama spent reading the prompt (small when the prefix cache was hit). */
	promptEvalMs?: number;
	/** Milliseconds Ollama spent generating. */
	evalMs?: number;
	/** Milliseconds spent loading the model, when it was not resident. */
	loadMs?: number;
}

export interface ApprovalRequest {
	/** Set when the dialog is shown although changes are being approved automatically: why this one is not. */
	caution?: string;
	tool: string;
	path: string;
	/** Existing content ("" for a new note). */
	before: string;
	/** Proposed content. */
	after: string;
	summary: string;
}

export type ApprovalDecision = "approve" | "reject" | "approve-all";

/** An approved write, with what it replaced, so it can be undone. */
export interface ChangeRecord {
	id: number;
	tool: string;
	path: string;
	before: string;
	after: string;
	/** Contents of a deleted attachment (absent when it was too large to keep). */
	binary?: ArrayBuffer;
	time: number;
	/** Identifies the agent turn (user message) the change belongs to. */
	turn: number;
	/** The chat the change was made in ("scheduled" for queued jobs, "plugin" for mechanical fixes). */
	chat?: string;
	/** When the change was undone (ms), if it was. */
	undone?: number;
	/** One line for the history list, e.g. "Add 2 block ids for citations". */
	summary?: string;
}

export interface ToolContext {
	vault: VaultAccess;
	search: (query: string, limit: number) => Promise<SearchHit[]>;
	/** Chunk-level semantic search; undefined when no embedding index is available. */
	searchPassages?: (query: string, limit: number) => Promise<Passage[]>;
	/** The words of a question that no indexed note contains; search_passages names them. */
	absentWords?: (query: string) => string[];
	/** A best passage score under this means "nothing close": search_passages then says so (depends on the embedding model; undefined = never). */
	weakMatchBelow?: number;
	/** Ask the user to approve a mutation. Resolves to the decision. */
	approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
	maxResultChars: number;
	/** The vault's configuration folder (Obsidian's `Vault.configDir`); never written to. */
	configDir?: string;
	signal?: AbortSignal;
	/** Called by mutating tools after a successful write so the change can be undone. */
	recordChange?(change: Pick<ChangeRecord, "tool" | "path" | "before" | "after" | "binary">): void;
	/** Notes fully read in this turn (path → content stamp), so a repeat read is short-circuited. */
	readLog?: Map<string, string>;
	/** Extracts text from an attachment (PDF, plain text); absent when unsupported. */
	readAttachmentText?: (path: string) => Promise<string>;
	/** Lecture Companion's structured lectures and transcripts; absent when it is not installed. */
	lectures?: LectureSource;
	/** Describes an image (or a PDF page) with the local vision model; absent when there is none. */
	describeImage?: (path: string, opts: { page?: number; question?: string }) => Promise<string>;
}

/** One lecture or meeting recorded by Lecture Companion. */
export interface LectureInfo {
	path: string;
	course: string;
	date: string;
	kind: "lecture" | "meeting";
	/** One-sentence summary, when Lecture Companion has written one. */
	sentence: string | null;
}

/** One transcript paragraph: `start` seconds into the recording. */
export interface TranscriptParagraph {
	start: number;
	text: string;
}

/** What the lecture tools need from Lecture Companion (its public API, version 1). */
export interface LectureSource {
	courses(): string[];
	lectures(course?: string): LectureInfo[];
	transcript(path: string): Promise<TranscriptParagraph[]>;
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
	/** A write was approved and applied during `call`; `change` is its undo record. */
	onChange?(change: ChangeRecord, call: ToolCall): void;
	/** Token counts of the latest model call, for a context meter. */
	onUsage?(usage: UsageInfo): void;
}
