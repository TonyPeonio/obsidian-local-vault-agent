import { ItemView, MarkdownRenderer, MarkdownView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type LocalVaultAgentPlugin from "./main";
import { GROUNDING_PREFIX, newConversation, type Conversation } from "./agent";
import { conversationToMarkdown } from "./transcript";
import type { ChangeRecord, ChatMessage, ToolCall, UsageInfo } from "./types";

export const VIEW_TYPE = "local-vault-agent-view";

const SUGGESTIONS = [
	"What have I written about …?",
	"Summarize my notes on …",
	"Compile everything about … into a new note",
	"Reformat the current note",
];

export class AgentView extends ItemView {
	private conversation: Conversation = newConversation();
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private modelSelect!: HTMLSelectElement;
	private abort: AbortController | null = null;
	private running = false;
	private unsubscribeStatus: (() => void) | null = null;
	private usage: UsageInfo | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: LocalVaultAgentPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Local Vault Agent";
	}
	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("lva-root");

		// Header
		const header = root.createDiv({ cls: "lva-header" });
		this.modelSelect = header.createEl("select", { cls: "dropdown lva-model-select" });
		this.modelSelect.addEventListener("change", () => {
			this.plugin.settings.model = this.modelSelect.value;
			void this.plugin.saveSettings();
		});
		void this.populateModels();
		const newChat = header.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": "New chat" } });
		setIcon(newChat, "plus");
		newChat.addEventListener("click", () => this.resetConversation());
		const copyChat = header.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": "Copy conversation as markdown" } });
		setIcon(copyChat, "clipboard-copy");
		copyChat.addEventListener("click", () => {
			const md = conversationToMarkdown(this.conversation.messages);
			if (!md.trim()) {
				new Notice("Nothing to copy yet.");
				return;
			}
			void navigator.clipboard.writeText(md);
			new Notice("Conversation copied as markdown.");
		});
		const refresh = header.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": "Refresh model list" } });
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => void this.populateModels(true));

		// Messages
		this.messagesEl = root.createDiv({ cls: "lva-messages" });
		this.renderWelcome();

		// Composer
		const composer = root.createDiv({ cls: "lva-composer" });
		this.inputEl = composer.createEl("textarea", {
			cls: "lva-input",
			attr: { placeholder: "Ask about your notes… (Enter to send, Shift+Enter for a new line)", rows: "2" },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.submit();
			}
		});
		this.inputEl.addEventListener("input", () => this.autoGrow());
		this.sendBtn = composer.createEl("button", { cls: "mod-cta lva-send" });
		this.setSendState(false);
		this.sendBtn.addEventListener("click", () => {
			if (this.running) this.stop();
			else void this.submit();
		});

		this.statusEl = root.createDiv({ cls: "lva-status" });
		this.unsubscribeStatus = this.plugin.onIndexStatus(() => this.updateStatus());
		this.updateStatus();
	}

	async onClose(): Promise<void> {
		this.stop();
		this.unsubscribeStatus?.();
		this.unsubscribeStatus = null;
	}

	/** Put text into the composer and focus it (used by commands). */
	prefill(text: string): void {
		this.inputEl.value = text;
		this.autoGrow();
		this.inputEl.focus();
	}

	/** Send a message programmatically (used by commands). */
	async send(text: string): Promise<void> {
		this.inputEl.value = text;
		await this.submit();
	}

	private async populateModels(notify = false): Promise<void> {
		const current = this.plugin.settings.model;
		this.modelSelect.empty();
		try {
			const models = await this.plugin.client.listModels();
			const chatModels = models.filter((m) => !/embed/i.test(m.name));
			for (const m of chatModels) {
				this.modelSelect.createEl("option", { value: m.name, text: m.name });
			}
			if (!chatModels.some((m) => m.name === current)) {
				this.modelSelect.createEl("option", { value: current, text: `${current} (not installed)` });
			}
			if (notify) new Notice(`Found ${chatModels.length} chat model${chatModels.length === 1 ? "" : "s"}.`);
		} catch (err) {
			this.modelSelect.createEl("option", { value: current, text: current });
			if (notify) new Notice(`Could not reach Ollama: ${(err as Error).message}`);
		}
		this.modelSelect.value = current;
	}

	private renderWelcome(): void {
		const el = this.messagesEl.createDiv({ cls: "lva-welcome" });
		el.createEl("p", { text: "Ask questions about your notes, compile topics, or ask for edits. Every change is shown as a diff before it is written." });
		const list = el.createDiv({ cls: "lva-suggestions" });
		for (const s of SUGGESTIONS) {
			const chip = list.createEl("button", { cls: "lva-chip", text: s });
			chip.addEventListener("click", () => this.prefill(s.endsWith("…?") || s.endsWith("…") ? s.replace(/…\??$/, "") : s));
		}
	}

	private resetConversation(): void {
		this.stop();
		this.conversation = newConversation();
		this.usage = null;
		this.messagesEl.empty();
		this.renderWelcome();
		this.inputEl.focus();
	}

	private autoGrow(): void {
		// Sizing is done in CSS (`field-sizing: content`), nothing to do here; kept as a hook
		// so callers that change the value programmatically read naturally.
	}

	private setSendState(running: boolean): void {
		this.running = running;
		this.sendBtn.empty();
		setIcon(this.sendBtn, running ? "square" : "send-horizontal");
		this.sendBtn.setAttribute("aria-label", running ? "Stop" : "Send");
		this.sendBtn.toggleClass("lva-stop", running);
	}

	private stop(): void {
		this.abort?.abort();
		this.abort = null;
	}

	private updateStatus(extra?: string): void {
		const s = this.plugin.index.status();
		const parts: string[] = [];
		if (extra) parts.push(extra);
		if (!s.enabled) parts.push("Keyword search only");
		else if (s.building) parts.push(`Indexing… ${s.indexedFiles} notes (${s.pending} left)`);
		else if (s.lastError) parts.push(`Index: ${s.lastError}`);
		else parts.push(`Index: ${s.indexedFiles} notes, ${s.totalChunks} chunks`);
		let warn = false;
		if (this.usage) {
			const used = this.usage.promptTokens + this.usage.completionTokens;
			const pct = Math.round((used / this.usage.numCtx) * 100);
			warn = pct >= 85;
			parts.push(`Context ${fmtK(used)} / ${fmtK(this.usage.numCtx)} (${pct}%)`);
		}
		this.statusEl.setText(parts.join(" · "));
		this.statusEl.toggleClass("lva-ctx-warn", warn);
	}

	private scrollToBottom(): void {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private async submit(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text || this.running) return;
		this.messagesEl.querySelector(".lva-welcome")?.remove();
		this.inputEl.value = "";
		this.autoGrow();

		const user = this.messagesEl.createDiv({ cls: "lva-msg lva-user" });
		user.createDiv({ cls: "lva-bubble", text });
		this.scrollToBottom();

		this.abort = new AbortController();
		this.setSendState(true);
		let turn: TurnRenderer | null = null;

		try {
			await this.plugin.agent.run(
				this.conversation,
				text,
				{
					onStatus: (s) => this.updateStatus(s),
					onAssistantStart: () => {
						turn = new TurnRenderer(this, this.messagesEl, this.plugin);
						this.scrollToBottom();
					},
					onThinkingDelta: (d) => {
						turn?.appendThinking(d);
						this.scrollToBottom();
					},
					onAssistantDelta: (d) => {
						turn?.appendContent(d);
						this.scrollToBottom();
					},
					onAssistantDone: (m) => {
						void turn?.finish(m);
						this.scrollToBottom();
					},
					onToolStart: (call) => {
						turn?.toolStart(call);
						this.scrollToBottom();
					},
					onToolDone: (call, result, ok) => {
						turn?.toolDone(call, result, ok);
						this.scrollToBottom();
					},
					onChange: (change, call) => turn?.attachUndo(call, change),
					onUsage: (u) => {
						this.usage = u;
						this.updateStatus("Working…");
					},
					onAutoContinue: (nudge) => {
						this.messagesEl.createDiv({
							cls: "lva-msg lva-note",
							text: nudge.startsWith(GROUNDING_PREFIX)
								? "The reply cited notes that do not exist — sent it back to search the vault first."
								: "The model asked whether to continue — answered yes automatically.",
						});
						this.scrollToBottom();
					},
				},
				this.abort.signal,
			);
		} catch (err) {
			if (!this.abort?.signal.aborted) {
				const message = (err as Error).message ?? String(err);
				const errEl = this.messagesEl.createDiv({ cls: "lva-msg lva-error" });
				errEl.createDiv({ cls: "lva-bubble", text: message });
				new Notice(message, 8000);
			}
		} finally {
			if (this.abort?.signal.aborted) {
				this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: "Stopped." });
			}
			this.abort = null;
			this.setSendState(false);
			this.updateStatus();
			this.scrollToBottom();
		}
	}

	async renderMarkdown(markdown: string, el: HTMLElement): Promise<void> {
		el.empty();
		await MarkdownRenderer.render(this.app, markdown, el, this.plugin.vault.getActiveNotePath() ?? "", this);
		el.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
			a.addEventListener("click", (e) => {
				e.preventDefault();
				const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
				void this.app.workspace.openLinkText(href, "", e.ctrlKey || e.metaKey);
			});
		});
	}

	insertAtCursor(text: string): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("Open a note in the editor first.");
			return;
		}
		view.editor.replaceSelection(text);
		new Notice("Inserted into the note.");
	}
}

/** Renders one assistant turn: thinking, streaming content, tool cards, actions. */
class TurnRenderer {
	private root: HTMLElement;
	private thinkingEl: HTMLDetailsElement | null = null;
	private thinkingBody: HTMLElement | null = null;
	private contentEl: HTMLElement;
	private content = "";
	private thinking = "";
	private renderTimer: number | null = null;
	private toolCards = new Map<ToolCall, HTMLDetailsElement>();

	constructor(
		private view: AgentView,
		parent: HTMLElement,
		private plugin: LocalVaultAgentPlugin,
	) {
		this.root = parent.createDiv({ cls: "lva-msg lva-assistant" });
		this.contentEl = this.root.createDiv({ cls: "lva-bubble lva-markdown lva-streaming" });
	}

	appendThinking(delta: string): void {
		this.thinking += delta;
		if (!this.plugin.settings.showThinking) return;
		if (!this.thinkingEl) {
			this.thinkingEl = this.root.createEl("details", { cls: "lva-thinking" });
			this.thinkingEl.open = true;
			this.thinkingEl.createEl("summary", { text: "Thinking…" });
			this.thinkingBody = this.thinkingEl.createDiv({ cls: "lva-thinking-body" });
			this.root.insertBefore(this.thinkingEl, this.contentEl);
		}
		this.thinkingBody!.setText(this.thinking);
	}

	appendContent(delta: string): void {
		this.content += delta;
		if (this.renderTimer) return;
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			void this.view.renderMarkdown(this.content, this.contentEl);
		}, 120);
	}

	async finish(message: ChatMessage): Promise<void> {
		if (this.renderTimer !== null) {
			window.clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
		if (this.thinkingEl) {
			this.thinkingEl.open = false;
			this.thinkingEl.querySelector("summary")!.setText("Thinking (click to show)");
		}
		this.content = message.content;
		this.contentEl.removeClass("lva-streaming");
		if (this.content.trim()) {
			await this.view.renderMarkdown(this.content, this.contentEl);
			const actions = this.root.createDiv({ cls: "lva-actions" });
			const copy = actions.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": "Copy" } });
			setIcon(copy, "copy");
			copy.addEventListener("click", () => {
				void navigator.clipboard.writeText(this.content);
				new Notice("Copied.");
			});
			const insert = actions.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": "Insert at cursor" } });
			setIcon(insert, "file-input");
			insert.addEventListener("click", () => this.view.insertAtCursor(this.content));
		} else {
			// A pure tool-call turn: nothing to show in the bubble.
			this.contentEl.remove();
		}
	}

	toolStart(call: ToolCall): void {
		const card = this.root.createEl("details", { cls: "lva-tool lva-tool-running" });
		const summary = card.createEl("summary");
		const icon = summary.createSpan({ cls: "lva-tool-icon" });
		setIcon(icon, iconFor(call.function.name));
		summary.createSpan({ cls: "lva-tool-name", text: call.function.name });
		summary.createSpan({ cls: "lva-tool-args", text: shortArgs(call) });
		const body = card.createDiv({ cls: "lva-tool-body" });
		body.createEl("pre", { cls: "lva-tool-pre", text: JSON.stringify(call.function.arguments, null, 2) });
		this.toolCards.set(call, card);
	}

	/** Adds an "Undo" button to the tool card whose write produced `change`. */
	attachUndo(call: ToolCall, change: ChangeRecord): void {
		const card = this.toolCards.get(call);
		if (!card) return;
		const summary = card.querySelector("summary");
		if (!summary) return;
		const btn = summary.createEl("button", { cls: "lva-undo-btn", text: "Undo" });
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.plugin.revert(change).then((done) => {
				if (done) {
					btn.disabled = true;
					btn.setText("Undone");
				}
			});
		});
	}

	toolDone(call: ToolCall, result: string, ok: boolean): void {
		const card = this.toolCards.get(call);
		if (!card) return;
		card.removeClass("lva-tool-running");
		card.addClass(ok ? "lva-tool-ok" : "lva-tool-error");
		const body = card.querySelector(".lva-tool-body") as HTMLElement;
		body.createEl("pre", {
			cls: "lva-tool-pre lva-tool-result",
			text: result.length > 3000 ? result.slice(0, 3000) + "\n…" : result,
		});
	}
}

function fmtK(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function iconFor(tool: string): string {
	switch (tool) {
		case "search_notes":
			return "search";
		case "read_note":
		case "get_active_note":
			return "file-text";
		case "list_notes":
		case "vault_overview":
			return "folder-tree";
		case "create_note":
			return "file-plus";
		default:
			return "pencil";
	}
}

function shortArgs(call: ToolCall): string {
	const a = call.function.arguments ?? {};
	const first = a.query ?? a.path ?? a.folder ?? a.tag ?? a.name_contains ?? "";
	const s = typeof first === "string" ? first : JSON.stringify(first);
	return s.length > 60 ? s.slice(0, 60) + "…" : s;
}
