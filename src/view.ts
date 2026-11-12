import { sameModel } from "./ollama";
import { ItemView, MarkdownRenderer, MarkdownView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type LocalVaultAgentPlugin from "./main";
import { AUTO_CONTINUE_TEXT, GROUNDING_PREFIX, newConversation, type Conversation } from "./agent";
import { ComposerSuggest } from "./composer-suggest";
import type { GardenFix, GardenReport } from "./gardener";
import { HELP_TEXT, attachMentions, matchCommands, matchNotes, parseSlash } from "./mentions";
import { conversationToMarkdown } from "./transcript";
import type { ChangeRecord, ChatMessage, ToolCall, UsageInfo } from "./types";

export const VIEW_TYPE = "local-vault-agent-view";

const SUGGESTIONS = [
	"What have I written about …?",
	"Compile everything about … into a new note",
	"Clean up every note that …",
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
	/** True while a mechanical /garden fix is being applied (its diffs are open). */
	private gardening = false;
	/** Whether the next message gets the notes it links to attached; off for prompts that only list notes. */
	private attachNext = true;
	private unsubscribeStatus: (() => void) | null = null;
	private unsubscribeGists: (() => void) | null = null;
	private usage: UsageInfo | null = null;
	private suggest: ComposerSuggest | null = null;

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
		void this.restoreChat();

		// Composer
		const composer = root.createDiv({ cls: "lva-composer" });
		this.inputEl = composer.createEl("textarea", {
			cls: "lva-input",
			attr: { placeholder: "Ask about your notes… (@ to attach a note, / for commands, Shift+Enter for a new line)", rows: "2" },
		});
		// Registered before the Enter-to-send handler so picking a suggestion wins.
		this.suggest = new ComposerSuggest(this.inputEl, composer, [
			{
				char: "@",
				items: (q) =>
					matchNotes(q, this.plugin.vault.listNotes()).map((n) => ({ key: n.path, title: n.basename, detail: n.folder || "/" })),
				pick: (item, replace) => replace(`[[${item.key.replace(/\.md$/i, "")}]] `),
			},
			{
				char: "/",
				items: (q) => matchCommands(q).map((c) => ({ key: c.id, title: c.name, detail: c.description })),
				pick: (item, replace) => {
					replace("");
					void this.runSlash(item.key);
				},
			},
		]);
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
		this.unsubscribeGists = this.plugin.onGistStatus(() => this.updateStatus());
		this.updateStatus();
	}

	async onClose(): Promise<void> {
		this.stop();
		this.unsubscribeStatus?.();
		this.unsubscribeStatus = null;
		this.unsubscribeGists?.();
		this.unsubscribeGists = null;
	}

	/** Put text into the composer and focus it (used by commands). */
	prefill(text: string): void {
		this.inputEl.value = text;
		this.autoGrow();
		this.inputEl.focus();
	}

	/** Send a message programmatically (used by commands). */
	async send(text: string, attachMentioned = true): Promise<void> {
		this.inputEl.value = text;
		this.attachNext = attachMentioned;
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
			if (!chatModels.some((m) => sameModel(m.name, current))) {
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
		el.createEl("p", { text: "Ask questions about your notes, compile topics, or ask for edits across many notes. Every change is shown as a diff before it is written and can be undone." });
		el.createEl("p", { cls: "lva-welcome-hint", text: "@ attaches a note to your message · / lists commands · Shift+Enter for a new line" });
		const list = el.createDiv({ cls: "lva-suggestions" });
		for (const s of SUGGESTIONS) {
			const chip = list.createEl("button", { cls: "lva-chip", text: s });
			chip.addEventListener("click", () => this.prefill(s.endsWith("…?") || s.endsWith("…") ? s.replace(/…\??$/, "") : s));
		}
	}

	/** Re-renders the saved conversation (if any) when the panel opens. */
	private async restoreChat(): Promise<void> {
		const messages = await this.plugin.loadChat();
		if (!messages || messages.length === 0 || this.conversation.messages.length > 0) return;
		this.conversation = { messages, approveAll: false };
		this.messagesEl.querySelector(".lva-welcome")?.remove();
		await this.renderHistory(messages);
		this.scrollToBottom();
	}

	private async renderHistory(messages: ChatMessage[]): Promise<void> {
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (m.role === "user") {
				if (m.content === AUTO_CONTINUE_TEXT || m.content.startsWith(GROUNDING_PREFIX) || /^Your reply was empty/.test(m.content)) {
					this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: "(auto-continued)" });
				} else {
					const user = this.messagesEl.createDiv({ cls: "lva-msg lva-user" });
					user.createDiv({ cls: "lva-bubble", text: m.content.split("\n\n(The user attached")[0] });
				}
			} else if (m.role === "assistant") {
				const root = this.messagesEl.createDiv({ cls: "lva-msg lva-assistant" });
				if (m.content.trim()) await this.renderMarkdown(m.content, root.createDiv({ cls: "lva-bubble lva-markdown" }));
				for (const call of m.tool_calls ?? []) {
					// The tool results follow the assistant message in call order.
					const candidate = messages[i + 1 + (m.tool_calls ?? []).indexOf(call)];
					const resultMsg = candidate?.role === "tool" ? candidate : undefined;
					const card = root.createEl("details", { cls: "lva-tool lva-tool-ok" });
					const summary = card.createEl("summary");
					const icon = summary.createSpan({ cls: "lva-tool-icon" });
					setIcon(icon, iconFor(call.function.name));
					summary.createSpan({ cls: "lva-tool-name", text: describeCall(call) });
					summary.createSpan({ cls: "lva-tool-args", text: resultMsg ? describeResult(call, resultMsg.content) : "" });
					const body = card.createDiv({ cls: "lva-tool-body" });
					body.createEl("pre", { cls: "lva-tool-pre", text: JSON.stringify(call.function.arguments, null, 2) });
					if (resultMsg) body.createEl("pre", { cls: "lva-tool-pre lva-tool-result", text: resultMsg.content.length > 3000 ? resultMsg.content.slice(0, 3000) + "\n…" : resultMsg.content });
				}
			}
		}
		this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: "Restored from the previous session." });
	}

	private resetConversation(): void {
		this.stop();
		void this.plugin.clearChat();
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
		const g = this.plugin.gists.status();
		if (g.enabled) {
			if (g.lastError) parts.push(`Gists: ${g.lastError}`);
			else if (g.building || g.pending > 0) parts.push(`Gists ${g.done}/${g.total}…`);
			else parts.push(`Gists ${g.done}/${g.total}`);
		}
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

	/** Runs a `/command` from the composer. */
	async runSlash(id: string): Promise<void> {
		this.suggest?.close();
		switch (id) {
			case "reformat":
				await this.plugin.reformatCurrentNote(this);
				break;
			case "summarize":
				await this.plugin.summarizeCurrentNote(this);
				break;
			case "edit":
				await this.plugin.editSelection(this);
				break;
			case "daily":
				await this.plugin.processDailyNotes(this);
				break;
			case "garden":
				await this.plugin.suggestImprovements(this);
				break;
			case "undo":
				await this.plugin.undoLast();
				break;
			case "undo-all":
				await this.plugin.undoLastTurn();
				break;
			case "new":
				this.resetConversation();
				break;
			case "gists":
				new Notice("Regenerating gists in the background…");
				void this.plugin.gists.syncAll(true);
				break;
			case "index":
				new Notice("Rebuilding the semantic index…");
				void this.plugin.index.syncAll(true);
				break;
			case "help": {
				this.messagesEl.querySelector(".lva-welcome")?.remove();
				const el = this.messagesEl.createDiv({ cls: "lva-msg lva-assistant" });
				await this.renderMarkdown(HELP_TEXT, el.createDiv({ cls: "lva-bubble lva-markdown" }));
				this.scrollToBottom();
				break;
			}
			default:
				new Notice(`Unknown command /${id}. Type / to see the list.`);
		}
	}

	/** Adds a user line and an assistant reply that the plugin itself produced (no model call) to the chat and its history. */
	private async appendExchange(userText: string, markdown: string): Promise<HTMLElement> {
		this.messagesEl.querySelector(".lva-welcome")?.remove();
		const user = this.messagesEl.createDiv({ cls: "lva-msg lva-user" });
		user.createDiv({ cls: "lva-bubble", text: userText });
		const root = this.messagesEl.createDiv({ cls: "lva-msg lva-assistant" });
		await this.renderMarkdown(markdown, root.createDiv({ cls: "lva-bubble lva-markdown" }));
		// History must start with a user message, hence the pair.
		this.conversation.messages.push({ role: "user", content: userText }, { role: "assistant", content: markdown });
		this.plugin.saveChat(this.conversation.messages);
		this.scrollToBottom();
		return root;
	}

	/**
	 * Shows the gardener's report as an assistant message with one button per section. The report
	 * joins the conversation, so "repoint the first three broken links" typed by hand works too.
	 * Nothing is written to the vault until a button is used, and then each change is a diff.
	 */
	async showGardenReport(markdown: string, fixes: GardenFix[], report: GardenReport, legacyNote: boolean): Promise<void> {
		if (this.running || this.gardening) {
			new Notice("Wait for the current reply to finish, or stop it, first.");
			return;
		}
		const root = await this.appendExchange("/garden", markdown);
		if (!fixes.length && !legacyNote) return;
		const row = root.createDiv({ cls: "lva-fixes" });
		for (const fix of fixes) {
			const btn = row.createEl("button", { cls: "lva-chip", text: fix.label });
			if (fix.prompt) btn.setAttribute("aria-label", "Asks the model for a proposal; this one takes a while on a slow machine.");
			btn.addEventListener("click", () => {
				if (this.running || this.gardening) return;
				btn.disabled = true;
				// The findings are in the prompt already; attaching every note they name would
				// hand the model tens of thousands of characters it then reads a second time.
				if (fix.prompt) void this.send(fix.prompt, false);
				else if (fix.action === "inboxes") void this.plugin.processDailyNotes(this);
				else void this.runGardenAction(fix, report);
			});
		}
		if (legacyNote) {
			const btn = row.createEl("button", { cls: "lva-chip", text: "Delete the old Vault Suggestions note" });
			btn.setAttribute("aria-label", "Earlier versions wrote this checklist note; its open checkboxes show up in task queries. Moves it to the trash.");
			btn.addEventListener("click", () => {
				btn.disabled = true;
				void this.plugin.deleteLegacySuggestions().then((done) => new Notice(done ? "Vault Suggestions moved to the trash." : "Vault Suggestions is already gone."));
			});
		}
		this.scrollToBottom();
	}

	/** A mechanical fix: the plugin plans the edits, shows each as a diff and reports. No model call. */
	private async runGardenAction(fix: GardenFix, report: GardenReport): Promise<void> {
		this.gardening = true;
		try {
			// The same turn number the changes are recorded under, so /undo-all takes back exactly this batch.
			const result = await this.plugin.applyGardenAction(fix.action, report, this.conversation.messages.length);
			if (result) await this.appendExchange(fix.label, result);
		} catch (err) {
			new Notice((err as Error).message ?? String(err), 8000);
		} finally {
			this.gardening = false;
		}
	}

	private async submit(): Promise<void> {
		const text = this.inputEl.value.trim();
		const attach = this.attachNext;
		this.attachNext = true;
		if (!text || this.running || this.gardening) return;
		const slash = parseSlash(text);
		if (slash) {
			this.inputEl.value = "";
			await this.runSlash(slash.id);
			return;
		}
		this.messagesEl.querySelector(".lva-welcome")?.remove();
		this.inputEl.value = "";
		this.autoGrow();

		const user = this.messagesEl.createDiv({ cls: "lva-msg lva-user" });
		user.createDiv({ cls: "lva-bubble", text });
		const { message, attached } = attach ? await attachMentions(text, this.plugin.vault, this.plugin.settings.maxToolResultChars * 2) : { message: text, attached: [] as string[] };
		if (attached.length) {
			user.createDiv({ cls: "lva-attached", text: `Attached: ${attached.map((p) => p.replace(/\.md$/i, "")).join(", ")}` });
		}
		this.scrollToBottom();

		this.abort = new AbortController();
		this.setSendState(true);
		this.plugin.agentBusy = true;
		let turn: TurnRenderer | null = null;
		const started = Date.now();
		let calls = 0;
		const progress = () => this.updateStatus(`Working… ${calls} tool call${calls === 1 ? "" : "s"} · ${Math.round((Date.now() - started) / 1000)} s`);
		const ticker = window.setInterval(progress, 1000);

		try {
			await this.plugin.agent.run(
				this.conversation,
				message,
				{
					onStatus: () => progress(),
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
						calls++;
						turn?.toolDone(call, result, ok);
						this.scrollToBottom();
					},
					onChange: (change, call) => turn?.attachUndo(call, change),
					onUsage: (u) => {
						this.usage = u;
						progress();
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
			window.clearInterval(ticker);
			if (this.abort?.signal.aborted) {
				this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: "Stopped." });
			}
			this.abort = null;
			this.setSendState(false);
			this.plugin.agentBusy = false;
			this.plugin.saveChat(this.conversation.messages);
			void this.plugin.checkPlacementOnce();
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
		summary.createSpan({ cls: "lva-tool-name", text: describeCall(call) });
		summary.createSpan({ cls: "lva-tool-args", text: "" });
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
		const args = card.querySelector(".lva-tool-args");
		if (args) args.setText(ok ? describeResult(call, result) : "failed");
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

function short(v: unknown, max = 48): string {
	const s = typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
	const noExt = s.replace(/\.md$/i, "");
	return noExt.length > max ? noExt.slice(0, max) + "…" : noExt;
}

/** "Searched “magnet problems”" instead of `search_notes {"query":…}`. */
function describeCall(call: ToolCall): string {
	const a = call.function.arguments ?? {};
	switch (call.function.name) {
		case "search_notes":
			return `Searched notes for “${short(a.query)}”`;
		case "search_passages":
			return `Searched passages for “${short(a.query)}”`;
		case "read_note":
			return `Read ${short(a.path)}${a.offset ? ` (from ${short(a.offset)})` : ""}`;
		case "read_section":
			return `Read ${short(a.path)} › ${short(a.heading, 30)}`;
		case "find_in_note":
			return `Looked for “${short(a.pattern, 30)}” in ${short(a.path)}`;
		case "grep_vault":
			return `Grepped the vault for “${short(a.pattern, 30)}”${a.folder ? ` in ${short(a.folder)}` : ""}`;
		case "list_sections":
			return `Checked sections for ${Array.isArray(a.containing) ? a.containing.map((t) => `“${short(t, 20)}”`).join(" / ") : ""}`;
		case "list_notes":
			return `Listed notes${a.folder ? ` in ${short(a.folder)}` : ""}${a.tag ? ` tagged ${short(a.tag)}` : ""}${a.name_contains ? ` matching “${short(a.name_contains)}”` : ""}`;
		case "list_files":
			return `Listed attachments${a.extension ? ` (.${short(a.extension)})` : ""}${a.folder ? ` in ${short(a.folder)}` : ""}`;
		case "vault_overview":
			return "Looked at the vault overview";
		case "get_active_note":
			return "Read the open note";
		case "create_note":
			return `Created ${short(a.path)}`;
		case "edit_note":
			return `Edited ${short(a.path)}`;
		case "edit_notes": {
			const n = Array.isArray(a.edits) ? a.edits.length : 0;
			return `Applied ${n} edit${n === 1 ? "" : "s"} across notes`;
		}
		case "append_to_note":
			return `Appended to ${short(a.path)}`;
		case "replace_note":
			return `Rewrote ${short(a.path)}`;
		case "move_note":
			return `Moved ${short(a.path)} → ${short(a.new_path)}`;
		case "delete_file":
			return `Deleted ${short(a.path)}`;
		case "read_file":
			return `Read attachment ${short(a.path)}`;
		default:
			return call.function.name;
	}
}

/** A few words about what came back, for the card's right-hand side. */
function describeResult(call: ToolCall, result: string): string {
	switch (call.function.name) {
		case "search_notes": {
			if (result.startsWith("No notes")) return "no results";
			const n = (result.match(/"path":/g) ?? []).length;
			return `${n} result${n === 1 ? "" : "s"}`;
		}
		case "search_passages": {
			const m = /^(\d+) passage/.exec(result);
			return m ? `${m[1]} passage${m[1] === "1" ? "" : "s"}` : result.startsWith("No passages") ? "no results" : "";
		}
		case "list_notes":
		case "list_files": {
			const m = /^(\d+) (note|file)/.exec(result);
			return m ? `${m[1]} ${m[2]}${m[1] === "1" ? "" : "s"}` : "none";
		}
		case "read_note":
		case "read_section":
		case "get_active_note":
		case "read_file": {
			const m = /length: (\d+) characters/.exec(result);
			return m ? `${Math.round(Number(m[1]) / 1000)}k chars` : result.startsWith("(unchanged") ? "unchanged" : "";
		}
		case "find_in_note": {
			const m = /^(\d+) match/.exec(result);
			return m ? `${m[1]} match${m[1] === "1" ? "" : "es"}` : "no match";
		}
		case "grep_vault": {
			const m = /^(\d+) matching lines? in (\d+) note/.exec(result);
			return m ? `${m[1]} lines in ${m[2]} notes` : "no match";
		}
		case "list_sections": {
			const m = /^(\d+) sections?/.exec(result);
			return m ? `${m[1]} section${m[1] === "1" ? "" : "s"}` : "none";
		}
		default:
			return result.length > 70 ? result.slice(0, 70) + "…" : result;
	}
}
