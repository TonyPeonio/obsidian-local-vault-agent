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
	/** Answer the model's "shall I proceed?" with "yes, continue" instead of returning to the user. */
	autoContinue: boolean;
	extraSystemPrompt: string;
}

/** How many times per turn the agent answers a permission question on the user's behalf. */
export const MAX_AUTO_CONTINUES = 3;

export const AUTO_CONTINUE_TEXT =
	"Yes. Continue without asking again: carry out everything you proposed, for every note involved, in this turn. Reading needs no permission and each change goes through the approval dialog. Report when you are done.";

export const GROUNDING_PREFIX = "Grounding check:";

/** Wikilink targets in `text` that do not resolve to any note in the vault. */
export function unresolvedLinks(text: string, vault: VaultAccess): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
		const target = m[1].trim();
		if (target && !vault.resolve(target)) out.add(target);
	}
	return Array.from(out);
}

export function groundingNudge(links: string[], readAnything: boolean): string {
	const cited = links.map((l) => `[[${l}]]`).join(", ");
	return readAnything
		? `${GROUNDING_PREFIX} your answer cites notes that do not exist in the vault (${cited}). Cite only paths that search_notes, list_notes or read_note actually returned, exactly as returned, and correct the answer.`
		: `${GROUNDING_PREFIX} you have not searched or read anything in this conversation, yet your answer cites notes that do not exist in the vault (${cited}). You cannot know the user's notes from memory. Search with search_notes, read the relevant notes, then answer citing only notes you actually read. If nothing relevant exists, say so.`;
}

/**
 * True when an assistant reply ends its turn by asking for the go-ahead rather than acting.
 * Deliberately narrow: a real clarifying question ("which folder?") must not match.
 */
export function looksLikePermissionQuestion(text: string): boolean {
	const t = text.trim();
	if (!t.includes("?")) return false;
	const tail = t.slice(-600);
	return /\b(would you like me to|do you want me to|shall i\b|should i (proceed|continue|start|go ahead)|want me to (proceed|continue|go ahead|start)|ready to proceed|may i (proceed|continue)|(proceed|continue|go ahead)\s*\?\s*$)/i.test(tail);
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
		"You are an autonomous assistant that lives inside the user's Obsidian vault and runs fully locally. You answer questions from the user's notes, compile information across notes, and edit, reformat, clean up or reorganise notes when asked.",
		"",
		"Work autonomously:",
		"- Finish the whole task in this turn. If it spans many notes, handle them one after another until every one is done; do not stop after the first to report progress.",
		"- Never ask for permission or confirmation to search, read or change notes. Reading needs none, and every write is shown to the user as a diff they approve or reject, so the approval dialog is the confirmation. Do not end a reply with 'Would you like me to proceed?' or 'Shall I check the next note?' — proceed.",
		"- Do not describe a plan and wait; carry it out. Stop to ask only when the request is genuinely ambiguous in a way that changes the outcome, and then ask one specific question.",
		"- Search snippets are not the note. Before concluding that a note lacks or contains something, read it with read_note, or use find_in_note for one specific passage.",
		"",
		"Grounding and style:",
		"- You know nothing about the user's notes until you read them. Every answer about the notes starts with search_notes (or read_note on a path you were given), then read_note on the relevant results. Never answer from memory or assumption, never invent note names, quotes or facts, and cite only notes you actually read. If nothing relevant exists, say so.",
		"- Refer to notes with wikilinks, e.g. [[Projects/Chess Robot]] (path without the .md extension), so the user can click through.",
		"- Keep answers concise and in markdown. When the task is complete, stop calling tools and give a short report of what you did and anything you could not do.",
		"",
		"Editing:",
		"- Small change: locate the exact passage with read_note or find_in_note, then call edit_note with old_text copied verbatim. If edit_note reports no match, use the candidate lines it returns; never guess at text you have not seen.",
		"- Whole-note rewrite or reformat: replace_note with the complete new content, keeping wikilinks and tags intact. If the note starts with a YAML frontmatter block (--- ... ---), keep it unchanged; if it has none, never add one.",
		"- Compile into a new note with create_note, citing the source notes as wikilinks. Add to the end of a note with append_to_note. Remove a note with delete_note (it goes to the trash).",
		"- If the user rejects a change, ask what they want instead; never retry the same edit.",
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
		let autoContinues = 0;
		let groundingNudges = 0;
		let toolsUsed = 0;
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
			if (calls.length === 0) {
				// A reply that cites notes which do not exist is fabricated. Send it back once.
				if (groundingNudges < 1) {
					const bad = unresolvedLinks(assistant.content, vault);
					if (bad.length > 0) {
						groundingNudges++;
						const nudge = groundingNudge(bad, toolsUsed > 0);
						conversation.messages.push({ role: "user", content: nudge });
						callbacks.onAutoContinue?.(nudge);
						continue;
					}
				}
				// Small models like to stop and ask "shall I go on?". The user already said what
				// they want and every write is approved separately, so answer for them.
				if (cfg.autoContinue && autoContinues < MAX_AUTO_CONTINUES && looksLikePermissionQuestion(assistant.content)) {
					autoContinues++;
					conversation.messages.push({ role: "user", content: AUTO_CONTINUE_TEXT });
					callbacks.onAutoContinue?.(AUTO_CONTINUE_TEXT);
					continue;
				}
				return;
			}

			for (const call of calls) {
				if (signal?.aborted) return;
				callbacks.onToolStart?.(call);
				toolsUsed++;
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
