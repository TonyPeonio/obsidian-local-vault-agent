import type { OllamaClient } from "./ollama";
import { OllamaError } from "./ollama";
import { ToolError, toOllamaTools } from "./tools";
import type {
	AgentCallbacks,
	ApprovalDecision,
	ApprovalRequest,
	ChatMessage,
	ToolCall,
	ToolContext,
	ToolDefinition,
	VaultAccess,
} from "./types";

export interface AgentConfig {
	model: string;
	numCtx: number;
	temperature: number;
	/** undefined = model default. */
	think?: boolean;
	keepAlive: string;
	maxIterations: number;
	maxToolResultChars: number;
	autoApprove: boolean;
	extraSystemPrompt: string;
}

export interface Conversation {
	messages: ChatMessage[];
	/** Set when the user picks "approve all" for this chat. */
	approveAll: boolean;
}

export function newConversation(): Conversation {
	return { messages: [], approveAll: false };
}

export interface AgentDeps {
	client: OllamaClient;
	vault: VaultAccess;
	tools: ToolDefinition[];
	search: ToolContext["search"];
	approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
	getConfig: () => AgentConfig;
	configDir?: string;
	now?: () => Date;
}

export function buildSystemPrompt(vault: VaultAccess, cfg: AgentConfig, now: Date): string {
	const notes = vault.listNotes();
	const active = vault.getActiveNotePath();
	const lines = [
		"You are a careful, helpful assistant that lives inside the user's Obsidian vault. You run fully locally. You answer questions from the user's own notes, compile information across notes, and edit or reformat notes when asked.",
		"",
		"How to work:",
		"- Ground every answer in the notes. Use search_notes first, then read_note on the most relevant results before answering. Do not invent facts about the user's notes; if nothing relevant exists, say so.",
		"- Refer to notes with wikilinks, e.g. [[Projects/Chess Robot]] (path without the .md extension), so the user can click through.",
		"- Before editing a note, read it with read_note. For small changes use edit_note with an exact old_text copied from the note. For reformatting or rewriting a whole note use replace_note with the complete new content, keeping wikilinks and tags intact. If the note starts with a YAML frontmatter block (--- ... ---), keep it unchanged; if it has none, never add one.",
		"- Every write is shown to the user as a diff for approval. If the user rejects a change, ask what they want instead; never retry the same edit.",
		"- When compiling information into a new note, create it with create_note and cite the source notes as wikilinks.",
		"- Keep answers concise and in markdown. When you have enough information, stop calling tools and answer.",
		"- Tool arguments must be valid JSON matching the tool's parameters.",
		"",
		`Today is ${now.toISOString().slice(0, 10)}. The vault has ${notes.length} markdown notes.`,
		active ? `The user currently has this note open: ${active}` : "No note is currently open in the editor.",
	];
	if (cfg.extraSystemPrompt.trim()) lines.push("", "Additional instructions from the user:", cfg.extraSystemPrompt.trim());
	return lines.join("\n");
}

/**
 * The agent loop: send the conversation to the model with the tool list, execute whatever
 * tools it calls, feed the results back, and repeat until it answers in prose.
 */
export class Agent {
	constructor(private deps: AgentDeps) {}

	async run(
		conversation: Conversation,
		userText: string,
		callbacks: AgentCallbacks,
		signal?: AbortSignal,
	): Promise<void> {
		const cfg = this.deps.getConfig();
		const { client, vault, tools } = this.deps;
		const now = this.deps.now ? this.deps.now() : new Date();
		const toolByName = new Map(tools.map((t) => [t.name, t]));

		conversation.messages.push({ role: "user", content: userText });

		const ctx: ToolContext = {
			vault,
			search: this.deps.search,
			maxResultChars: cfg.maxToolResultChars,
			configDir: this.deps.configDir,
			signal,
			approve: async (req) => {
				if (cfg.autoApprove || conversation.approveAll) return "approve";
				const decision = await this.deps.approve(req);
				if (decision === "approve-all") conversation.approveAll = true;
				return decision;
			},
		};

		let think = cfg.think;
		for (let iteration = 0; iteration < cfg.maxIterations; iteration++) {
			if (signal?.aborted) return;
			const system: ChatMessage = { role: "system", content: buildSystemPrompt(vault, cfg, now) };
			const history = trimHistory(conversation.messages, cfg.numCtx);
			callbacks.onStatus?.(iteration === 0 ? "Thinking…" : "Working…");
			callbacks.onAssistantStart?.();

			let response;
			try {
				response = await client.chat({
					model: cfg.model,
					messages: [system, ...history],
					tools: toOllamaTools(tools),
					think,
					options: { num_ctx: cfg.numCtx, temperature: cfg.temperature },
					keep_alive: cfg.keepAlive,
					signal,
					onDelta: (d) => {
						if (d.content) callbacks.onAssistantDelta?.(d.content);
						if (d.thinking) callbacks.onThinkingDelta?.(d.thinking);
					},
				});
			} catch (err) {
				if (signal?.aborted) return;
				// Models without a thinking mode reject `think`; retry once without it.
				if (think !== undefined && err instanceof OllamaError && /think/i.test(err.message)) {
					think = undefined;
					iteration--;
					continue;
				}
				// Models without tool support: explain instead of looping.
				if (err instanceof OllamaError && /does not support tools/i.test(err.message)) {
					throw new OllamaError(
						`The model "${cfg.model}" does not support tool calling, which this plugin needs. Pick a model with the "tools" capability (for example qwen3.5, qwen3, llama3.1 or mistral) in settings.`,
					);
				}
				throw err;
			}

			const assistant = response.message;
			conversation.messages.push(assistant);
			callbacks.onAssistantDone?.(assistant);

			const calls = assistant.tool_calls ?? [];
			if (calls.length === 0) return;

			for (const call of calls) {
				if (signal?.aborted) return;
				callbacks.onToolStart?.(call);
				const { result, ok } = await this.executeTool(call, toolByName, ctx, cfg.maxToolResultChars);
				callbacks.onToolDone?.(call, result, ok);
				conversation.messages.push({ role: "tool", content: result, tool_name: call.function.name });
			}
		}

		// Ran out of iterations: ask the model to wrap up without tools.
		callbacks.onAssistantStart?.();
		const system: ChatMessage = { role: "system", content: buildSystemPrompt(vault, cfg, now) };
		const response = await this.deps.client.chat({
			model: cfg.model,
			messages: [
				system,
				...trimHistory(conversation.messages, cfg.numCtx),
				{ role: "user", content: "You have used the maximum number of tool calls for this turn. Answer now with what you have found so far, and say what is still missing." },
			],
			think,
			options: { num_ctx: cfg.numCtx, temperature: cfg.temperature },
			keep_alive: cfg.keepAlive,
			signal,
			onDelta: (d) => {
				if (d.content) callbacks.onAssistantDelta?.(d.content);
				if (d.thinking) callbacks.onThinkingDelta?.(d.thinking);
			},
		});
		conversation.messages.push(response.message);
		callbacks.onAssistantDone?.(response.message);
	}

	private async executeTool(
		call: ToolCall,
		toolByName: Map<string, ToolDefinition>,
		ctx: ToolContext,
		maxChars: number,
	): Promise<{ result: string; ok: boolean }> {
		const tool = toolByName.get(call.function.name);
		if (!tool) {
			return {
				ok: false,
				result: `Error: unknown tool "${call.function.name}". Available tools: ${Array.from(toolByName.keys()).join(", ")}.`,
			};
		}
		try {
			const raw = await tool.execute(call.function.arguments ?? {}, ctx);
			const result =
				raw.length > maxChars + 500
					? raw.slice(0, maxChars) + `\n\n[Result truncated at ${maxChars} characters.]`
					: raw;
			return { result, ok: true };
		} catch (err) {
			if (ctx.signal?.aborted) throw err;
			const message = err instanceof ToolError ? err.message : `${(err as Error).message ?? err}`;
			return { result: `Error: ${message}`, ok: false };
		}
	}
}

/**
 * Keep the conversation under the context window. Budget is a character estimate
 * (~3.2 chars/token for mixed markdown + JSON) leaving a third of the window for the
 * system prompt, tool schemas and the reply. Old tool results are shortened first;
 * whole early turns are dropped after that.
 */
export function trimHistory(messages: ChatMessage[], numCtx: number): ChatMessage[] {
	const budget = Math.floor(numCtx * 3.2 * 0.6);
	const size = (m: ChatMessage) =>
		m.content.length + (m.thinking?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);

	let out = messages.map((m) => ({ ...m }));
	// Reasoning from earlier turns is never useful to the model again; drop it unconditionally.
	const lastUser = out.map((m) => m.role).lastIndexOf("user");
	for (let i = 0; i < lastUser; i++) {
		if (out[i].role === "assistant" && out[i].thinking) delete out[i].thinking;
	}
	let total = out.reduce((n, m) => n + size(m), 0);
	if (total <= budget) return out;

	// Pass 1: shorten tool results that are not part of the most recent turn.
	for (let i = 0; i < lastUser && total > budget; i++) {
		const m = out[i];
		if (m.role === "tool" && m.content.length > 400) {
			total -= m.content.length - 400;
			m.content = m.content.slice(0, 400) + "\n[earlier tool result shortened]";
		}
	}
	// Pass 2: drop oldest turns, always keeping the latest user message onward.
	while (total > budget && out.length > 1) {
		const firstUser = out.findIndex((m) => m.role === "user");
		const nextUser = out.findIndex((m, i) => i > firstUser && m.role === "user");
		if (nextUser < 0) break;
		const dropped = out.splice(0, nextUser);
		total -= dropped.reduce((n, m) => n + size(m), 0);
	}
	// Never start with a tool message; the model has no call to attach it to.
	while (out.length && out[0].role !== "user") out.shift();
	return out;
}
