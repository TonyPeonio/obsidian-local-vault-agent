import type { OllamaClient } from "./ollama";
import { OllamaError } from "./ollama";
import { buildOutline, outlineBudget } from "./outline";
import { ToolError, toOllamaTools } from "./tools";
import type { UndoStack } from "./undo";
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

/**
 * Small models cite notes as `` `Projects/Note.md` `` instead of [[Projects/Note]]. Turn a
 * backticked path that resolves to a note into a wikilink so citations are clickable; code
 * fences and anything that is not a note path are left alone.
 */
export function linkifyNotePaths(text: string, vault: VaultAccess): string {
	const parts = text.split(/(```[\s\S]*?```)/);
	return parts
		.map((part, i) => {
			if (i % 2 === 1) return part;
			return part.replace(/`([^`\n]{1,200}?)`/g, (whole, inner: string) => {
				const candidate = inner.trim();
				if (!/\.md$/i.test(candidate) && !candidate.includes("/")) return whole;
				if (/[*?<>"]/.test(candidate)) return whole;
				const resolved = vault.resolve(candidate);
				if (!resolved) return whole;
				return `[[${resolved.replace(/\.md$/i, "")}]]`;
			});
		})
		.join("");
}

/** Wikilink targets in `text` that do not resolve to any note in the vault. */
export function unresolvedLinks(text: string, vault: VaultAccess): string[] {
	const out = new Set<string>();
	// Quoted text is not a citation: ignore code fences, inline code and embeds (![[file.m4a]]).
	const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
	for (const m of prose.matchAll(/(!?)\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
		if (m[1] === "!") continue;
		const target = m[2].trim();
		if (!target) continue;
		// Links to attachments (anything with a non-markdown extension) are not note citations.
		if (/\.[a-z0-9]{1,5}$/i.test(target) && !/\.md$/i.test(target)) continue;
		if (!vault.resolve(target) && !vault.resolveFile(target)) out.add(target);
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
 * True when the reply asks the user to pick between alternatives ("which one?", "A or B?",
 * "what would you like instead?"). Answering "yes, go ahead" to that is wrong, so such a
 * question is always returned to the user.
 */
export function looksLikeChoiceQuestion(text: string): boolean {
	const t = text.trim();
	if (!t.includes("?")) return false;
	return /\b(which (one|ones|of these|of the|would you|do you|should i)|what would you (like|prefer|rather)|instead\s*\?|or (do|would|should) you\b|\boptions?\s*:)/i.test(t);
}

/**
 * True when an assistant reply ends its turn by asking for the go-ahead rather than acting.
 * Deliberately narrow: a real clarifying question ("which folder?") must not match.
 */
export function looksLikePermissionQuestion(text: string): boolean {
	const t = text.trim();
	if (!t.includes("?")) return false;
	const tail = t.slice(-600);
	// An offer of *new* work ("would you like me to create a summary note?") is not a request
	// to continue the task the user gave; it goes back to the user.
	if (/\b(would you like|do you want|want me|shall i|should i|may i|can i)\b[^?]{0,40}\b(create|make|write|add|draft|generate|build|compile|consolidate|set up|summari[sz]e|organi[sz]e|turn (this|these|it) into)\b/i.test(tail)) {
		return false;
	}
	const continuing =
		"(proceed|continue|go ahead|carry on|move on|start|begin|keep going|do (the|all|every|each|that|this|these|those|so|it)|check(ing)? (the )?(full|next|other|remaining|rest)|(read|open|look at|inspect|handle|process|clean up|fix|update|remove|delete|apply|run)(ing)? (the |all |each |every |these |those )?(next|other|remaining|rest|full|same|changes?|edits?|notes?|files?|deletions?))";
	const asks = new RegExp(`\\b(would you like me to|do you want me to|shall i|should i|want me to|may i)\\s+(also\\s+)?${continuing}\\b`, "i");
	return asks.test(tail) || /\b(ready to proceed|(proceed|continue|go ahead|carry on)\s*\?\s*$)/i.test(tail);
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
	/** Chunk-level semantic search; absent when there is no embedding index. */
	searchPassages?: ToolContext["searchPassages"];
	approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
	getConfig: () => AgentConfig;
	configDir?: string;
	now?: () => Date;
	/** Receives every approved write so it can be undone later. */
	undo?: UndoStack;
	/** Contents of the user's conventions note (AGENT.md), or null when there is none. */
	readConventions?: () => Promise<string | null>;
	/** Cached one-line gist of a note, for the outline. */
	gist?: (path: string) => string | undefined;
	/** Text of an attachment (PDF, text file) for read_file. */
	readAttachmentText?: ToolContext["readAttachmentText"];
	/** Today's daily note, per the user's daily-notes settings. */
	dailyNote?: () => { path: string; exists: boolean } | null;
}

export function buildSystemPrompt(
	vault: VaultAccess,
	cfg: AgentConfig,
	now: Date,
	conventions: string | null = null,
	gist?: (path: string) => string | undefined,
	daily: { path: string; exists: boolean } | null = null,
): string {
	const notes = vault.listNotes();
	const active = vault.getActiveNotePath();
	const lines = [
		"You are an autonomous assistant that lives inside the user's Obsidian vault and runs fully locally. You answer questions from the user's notes, compile information across notes, and edit, reformat, clean up or reorganise notes when asked.",
		"",
		"Work autonomously:",
		"- Finish the whole task in this turn. If it spans many notes, handle them one after another until every one is done; do not stop after the first to report progress.",
		"- Never ask for permission or confirmation to search, read or change notes. Reading needs none, and every write is shown to the user as a diff they approve or reject, so the approval dialog is the confirmation. Do not end a reply with 'Would you like me to proceed?' or 'Shall I check the next note?' — proceed.",
		"- Do not describe a plan and wait; carry it out. Stop to ask only when the request is genuinely ambiguous in a way that changes the outcome, and then ask one specific question.",
		"- For a task that touches more than two notes, begin with one line stating the plan (which notes, what you will do to each), then start immediately in the same reply; as you go, note each note as done in a few words.",
		"- A question gets an answer, not edits. When the user asks something, answer it from the notes and stop; do not propose, offer or make changes to notes they did not ask for.",
		"- Search snippets are not the note. Before concluding that a note lacks or contains something, read it with read_note, or use find_in_note for one specific passage.",
		"- Never read every note to find something. To find all occurrences of a pattern across the vault (an embed, a tag, a phrase, a heading), use grep_vault; then read_section or find_in_note only where needed. Call at most about 6 tools per step; big batches overflow the context window.",
		"- Tool results are authoritative: a successful edit result means the note is written, so do not read it again to verify, and do not re-check notes that were already handled.",
		"",
		"Grounding and style:",
		"- You know nothing about the contents of the user's notes until you read them. The vault outline below tells you which notes exist and their headings, nothing more. Every answer about the notes starts with search_passages or search_notes (or read_note / read_section on a path from the outline), then reading the relevant results. Never answer from memory or assumption, never invent note names, quotes or facts, and cite only notes you actually read. If nothing relevant exists, say so.",
		"- Prefer search_passages for questions: it returns the matching sections verbatim, which is usually enough to answer. Use read_section to get one heading's full text, and read_note only when you need the whole note.",
		"- Refer to notes with wikilinks, e.g. [[Projects/Chess Robot]] (path without the .md extension), never as backticked paths, so the user can click through.",
		"- Keep answers concise and in markdown. When the task is complete, stop calling tools and give a short report of what you did and anything you could not do.",
		"",
		"Editing:",
		"- Small change: locate the exact passage with read_note or find_in_note, then call edit_note with old_text copied verbatim. If edit_note reports no match, use the candidate lines it returns; never guess at text you have not seen.",
		"- Whole-note rewrite or reformat: replace_note with the complete new content, keeping wikilinks and tags intact. If the note starts with a YAML frontmatter block (--- ... ---), keep it unchanged; if it has none, never add one.",
		"- Compile into a new note with create_note, citing the source notes as wikilinks. Add to the end of a note with append_to_note.",
		"- Non-markdown files (recordings, images, PDFs, …) are attachments: list them with list_files; read the text of a PDF or text file with read_file; they cannot be edited. Move or rename with move_note (links in other notes are updated). Remove any note or attachment with delete_file (it goes to the trash).",
		"- If the user rejects a change, stop, tell them what was rejected and ask what they want instead; never retry the same change.",
		"- Tool arguments must be valid JSON matching the tool's parameters.",
		"",
		`Today is ${now.toISOString().slice(0, 10)}. The vault has ${notes.length} markdown notes.`,
		active ? `The user currently has this note open: ${active}` : "No note is currently open in the editor.",
		daily ? `Today's daily note is ${daily.path}${daily.exists ? "" : " (it does not exist yet; create it if the user wants something added to today)"}.` : "",
		"",
		"Vault outline (every note, grouped by folder). Each line is `<file>.md — <gist or headings> <tags>`; a note's path is the folder plus the file name only, never the text after the dash:",
		buildOutline(vault, { budgetChars: outlineBudget(cfg.numCtx, gist !== undefined), gist }),
	];
	if (conventions?.trim()) lines.push("", "The user's vault conventions (from their conventions note; follow them):", conventions.trim());
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

		const turn = conversation.messages.length;
		conversation.messages.push({ role: "user", content: userText });
		let conventions: string | null = null;
		try {
			conventions = (await this.deps.readConventions?.()) ?? null;
		} catch {
			conventions = null;
		}

		let currentCall: ToolCall | null = null;
		const ctx: ToolContext = {
			vault,
			search: this.deps.search,
			searchPassages: this.deps.searchPassages,
			maxResultChars: cfg.maxToolResultChars,
			configDir: this.deps.configDir,
			signal,
			readLog: new Map(),
			readAttachmentText: this.deps.readAttachmentText,
			recordChange: (change) => {
				if (!this.deps.undo || !currentCall) return;
				const record = this.deps.undo.push({ ...change, time: now.getTime(), turn });
				callbacks.onChange?.(record, currentCall);
			},
			approve: async (req) => {
				if (cfg.autoApprove || conversation.approveAll) return "approve";
				const decision = await this.deps.approve(req);
				if (decision === "approve-all") conversation.approveAll = true;
				if (decision === "reject") rejected = true;
				return decision;
			},
		};

		let think = cfg.think;
		// Once the user has rejected a change in this turn, the model's next question is a real
		// one ("what instead?") and must reach the user: no more auto-continuing.
		let rejected = false;
		let autoContinues = 0;
		let groundingNudges = 0;
		let emptyNudges = 0;
		let toolsUsed = 0;
		for (let iteration = 0; iteration < cfg.maxIterations; iteration++) {
			if (signal?.aborted) return;
			const system: ChatMessage = { role: "system", content: buildSystemPrompt(vault, cfg, now, conventions, this.deps.gist, this.deps.dailyNote?.() ?? null) };
			const history = trimHistory(conversation.messages, cfg.numCtx, (m) => {
				// A shortened read is no longer "already above"; let the model read it again.
				const header = /^# (.+)$/m.exec(m.content);
				if (m.tool_name === "read_note" && header) ctx.readLog?.delete(header[1].trim());
			});
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
			if (assistant.content) assistant.content = linkifyNotePaths(assistant.content, vault);
			conversation.messages.push(assistant);
			callbacks.onAssistantDone?.(assistant);
			if (response.promptTokens !== undefined) {
				callbacks.onUsage?.({ promptTokens: response.promptTokens, completionTokens: response.completionTokens ?? 0, numCtx: cfg.numCtx });
			}

			const calls = assistant.tool_calls ?? [];
			if (calls.length === 0 && !assistant.content.trim() && emptyNudges < 1) {
				// A blank reply (usually after a huge tool batch) is never what the user wants.
				emptyNudges++;
				const nudge = "Your reply was empty. Answer now with what you have found so far; if a step is still missing, do it.";
				conversation.messages.push({ role: "user", content: nudge });
				callbacks.onAutoContinue?.(nudge);
				continue;
			}
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
				if (
					cfg.autoContinue &&
					!rejected &&
					autoContinues < MAX_AUTO_CONTINUES &&
					looksLikePermissionQuestion(assistant.content) &&
					!looksLikeChoiceQuestion(assistant.content)
				) {
					autoContinues++;
					conversation.messages.push({ role: "user", content: AUTO_CONTINUE_TEXT });
					callbacks.onAutoContinue?.(AUTO_CONTINUE_TEXT);
					continue;
				}
				return;
			}

			let batchChars = 0;
			const cap = batchBudget(cfg.numCtx);
			for (const [i, call] of calls.entries()) {
				if (signal?.aborted) return;
				callbacks.onToolStart?.(call);
				toolsUsed++;
				currentCall = call;
				let { result, ok } = await this.executeTool(call, toolByName, ctx, cfg.maxToolResultChars);
				currentCall = null;
				// A batch of forty read_note calls would overflow the window on its own; keep the
				// batch within budget and tell the model to work in smaller steps.
				batchChars += result.length;
				if (batchChars > cap && i < calls.length - 1 && result.length > 400) {
					result = result.slice(0, 400) + `\n[truncated: this batch of ${calls.length} tool calls returned too much at once. Call fewer tools per step (at most ~6) and use grep_vault, search_passages or read_section instead of reading whole notes.]`;
				}
				callbacks.onToolDone?.(call, result, ok);
				conversation.messages.push({ role: "tool", content: result, tool_name: call.function.name });
			}
		}

		// Ran out of iterations: ask the model to wrap up without tools.
		callbacks.onAssistantStart?.();
		const system: ChatMessage = { role: "system", content: buildSystemPrompt(vault, cfg, now, conventions, this.deps.gist, this.deps.dailyNote?.() ?? null) };
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
export function trimHistory(messages: ChatMessage[], numCtx: number, onShortened?: (m: ChatMessage) => void): ChatMessage[] {
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
	// Pass 3: still over budget inside the current turn (a long multi-note task). Shorten this
	// turn's tool results oldest first, keeping the two most recent intact, so the system prompt
	// and the user's request are never pushed out of the window by Ollama's own truncation.
	const current = out.map((m, i) => (i > lastUser && m.role === "tool" ? i : -1)).filter((i) => i >= 0);
	for (let k = 0; k < current.length - 2 && total > budget; k++) {
		const m = out[current[k]];
		if (m.content.length > 600) {
			total -= m.content.length - 600;
			m.content = m.content.slice(0, 600) + "\n[earlier result in this turn shortened to save context; call the tool again if you still need it]";
			onShortened?.(m);
		}
	}
	// Never start with a tool message; the model has no call to attach it to.
	while (out.length && out[0].role !== "user") out.shift();
	return out;
}

/** Total characters a single batch of tool results may add to the conversation. */
export function batchBudget(numCtx: number): number {
	return Math.floor(numCtx * 3.2 * 0.25);
}
