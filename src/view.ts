import { chatModelOptions } from "./model-picker";
import { sameModel } from "./ollama";
import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type LocalVaultAgentPlugin from "./main";
import { AUTO_CONTINUE_TEXT, FOLLOW_THROUGH_TEXT, GROUNDING_PREFIX, newConversation, type Conversation } from "./agent";
import { unattendedWrites } from "./approval";
import { recordOutcomes, restoredCards, type ToolOutcome } from "./chat-restore";
import type { Lease } from "./busy";
import { ComposerSuggest } from "./composer-suggest";
import type { GardenFix, GardenReport } from "./gardener";
import { HELP_TEXT, attachMentions, matchCommands, matchNotes, parseSlash } from "./mentions";
import { conversationToMarkdown } from "./transcript";
import { QuizSession, isNonAnswer, parseQuizRequest, questionMarkdown, renderReview, resultMarkdown, reviewNotePath, selectQuizNotes } from "./quiz";
import { VoiceRecorder } from "./voice";
import { t, type I18nKey } from "./i18n";
import { log } from "./log";
import { SAMPLE_QUESTIONS } from "./sample";
import { ScrollFollow } from "./scroll-follow";
import { StreamRenderer, nextRenderDelay } from "./stream-blocks";
import { describeCall, describeResult, iconFor } from "./tool-cards";
import { TurnProgress, formatDuration, formatTokens, phaseText, shouldNotify, summaryText } from "./turn-progress";
import { stillApplied } from "./undo";
import type { ChangeRecord, ChatMessage, ToolCall, UsageInfo } from "./types";

export const VIEW_TYPE = "local-vault-agent-view";

const SUGGESTIONS: I18nKey[] = ["view.chip.written", "view.chip.compile", "view.chip.cleanup", "view.chip.reformat"];

export class AgentView extends ItemView {
	private conversation: Conversation = newConversation();
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private modelSelect!: HTMLSelectElement;
	/** The bar above the message box that says changes are being written without a diff, with "Turn off". */
	private approveAllEl!: HTMLElement;
	private approveAllText!: HTMLElement;
	private approveAllShown: "chat" | "setting" | null = null;
	/** The bar that names a scheduled job while it runs, with "Stop". */
	private jobBarEl!: HTMLElement;
	private jobBarText!: HTMLElement;
	private jobStopBtn!: HTMLButtonElement;
	private unsubscribeBusy: (() => void) | null = null;
	/** The right to use the model while a chat turn or a quiz step of this view runs; Stop aborts through it. */
	private lease: Lease | null = null;
	/** Turns (by their list of reported changes) that already show the partial-undo offer. */
	private partialOffered = new WeakSet<ChangeRecord[]>();
	private running = false;
	/** True while a mechanical /garden fix is being applied (its diffs are open). */
	private gardening = false;
	/** Whether the next message gets the notes it links to attached; off for prompts that only list notes. */
	private attachNext = true;
	private unsubscribeStatus: (() => void) | null = null;
	private unsubscribeGists: (() => void) | null = null;
	private usage: UsageInfo | null = null;
	/** Size of the prompt before any conversation (system prompt and tools), learned from the first call of a chat: the guess for "Reading about N tokens…" in a new chat. */
	private prefixTokens: number | null = null;
	private suggest: ComposerSuggest | null = null;
	/** The quiz in progress: while set, the composer's messages are answers, graded instead of sent to the agent. */
	private quiz: QuizSession | null = null;
	private quizSources = new Map<string, string>();
	private quizBusy = false;
	private micBtn: HTMLButtonElement | null = null;
	/** How each tool call of this session ended, written onto the saved chat so a restored one is drawn as it was. */
	private outcomes = new WeakMap<ToolCall, ToolOutcome>();
	private recorder = new VoiceRecorder();
	/** Not visible: what a screen reader is told once, such as a reply that has finished streaming. */
	private announcerEl!: HTMLElement;
	/** Whether new text pulls the list to the bottom: only while the reader is there. */
	private follow = new ScrollFollow();
	private jumpBtn!: HTMLButtonElement;

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
		return t("view.title");
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
		this.modelSelect = header.createEl("select", { cls: "dropdown lva-model-select", attr: { "aria-label": t("view.modelSelect") } });
		this.modelSelect.addEventListener("change", () => {
			this.plugin.settings.model = this.modelSelect.value;
			void this.plugin.saveSettings();
			// As the settings tab does: whether read_image is offered depends on the chat model when no vision model is set.
			void this.plugin.refreshVision();
		});
		void this.populateModels();
		const newChat = header.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": t("view.newChat") } });
		setIcon(newChat, "plus");
		newChat.addEventListener("click", () => this.resetConversation());
		const copyChat = header.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": t("view.copyChat") } });
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
		const refresh = header.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": t("view.refreshModels") } });
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => void this.populateModels(true));

		// Messages
		// A live region: screen readers announce new messages as they arrive. A reply that is being
		// written is kept out of it (it changes several times a second) and read once when it is finished.
		this.messagesEl = root.createDiv({ cls: "lva-messages", attr: { role: "log", "aria-live": "polite", "aria-label": t("view.messages") } });
		this.announcerEl = root.createDiv({ cls: "lva-sr-only", attr: { role: "status", "aria-live": "polite" } });
		// Scrolled up to read: new text stays below, and this button goes to it.
		this.messagesEl.addEventListener(
			"scroll",
			() => {
				this.follow.onScroll(this.messagesEl);
				this.syncJump();
			},
			{ passive: true },
		);
		this.jumpBtn = root.createDiv({ cls: "lva-jump-row" }).createEl("button", { cls: "lva-jump" });
		setIcon(this.jumpBtn.createSpan({ cls: "lva-jump-icon" }), "arrow-down");
		this.jumpBtn.createSpan({ text: t("view.jump") });
		this.jumpBtn.addEventListener("click", () => {
			this.scrollToBottom(true);
			this.inputEl.focus();
		});
		this.jumpBtn.hide();
		this.renderWelcome();
		void this.restoreChat();

		// "Approve all" is never silent: while changes are written without a diff, this bar says so.
		this.approveAllEl = root.createDiv({ cls: "lva-approve-all", attr: { role: "status" } });
		setIcon(this.approveAllEl.createSpan({ cls: "lva-approve-all-icon" }), "alert-triangle");
		this.approveAllText = this.approveAllEl.createSpan({ cls: "lva-approve-all-text" });
		const approveOff = this.approveAllEl.createEl("button", { cls: "lva-chip", text: t("view.approveAll.off") });
		approveOff.addEventListener("click", () => this.turnOffApproveAll());
		this.approveAllEl.hide();

		// A scheduled job has the model: the chat says so (a message would be refused) and can stop it.
		this.jobBarEl = root.createDiv({ cls: "lva-job-bar", attr: { role: "status" } });
		setIcon(this.jobBarEl.createSpan({ cls: "lva-job-bar-icon" }), "clock");
		this.jobBarText = this.jobBarEl.createSpan({ cls: "lva-job-bar-text" });
		this.jobStopBtn = this.jobBarEl.createEl("button", { cls: "lva-chip", text: t("job.stop") });
		this.jobStopBtn.addEventListener("click", () => this.plugin.stopJob());
		this.unsubscribeBusy = this.plugin.busy.onChange(() => this.syncJobBar());
		this.syncJobBar();

		// Composer
		const composer = root.createDiv({ cls: "lva-composer" });
		this.inputEl = composer.createEl("textarea", {
			cls: "lva-input",
			attr: { placeholder: t("view.input.placeholder"), rows: "2", "aria-label": t("view.input.label") },
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
		this.inputEl.addEventListener("focus", () => {
			this.updateMic();
			this.syncApproveAll();
		});
		// Voice input goes through Lecture Companion's whisper server; without it there is no button.
		this.micBtn = composer.createEl("button", { cls: "clickable-icon lva-mic", attr: { "aria-label": t("view.mic") } });
		setIcon(this.micBtn, "mic");
		this.micBtn.addEventListener("click", () => void this.toggleMic());
		this.updateMic();
		this.sendBtn = composer.createEl("button", { cls: "mod-cta lva-send" });
		this.setSendState(false);
		this.sendBtn.addEventListener("click", () => {
			if (this.running) this.stop();
			else void this.submit();
		});

		// No role="status": the line is rewritten every second during a turn, and a live region would
		// read each tick aloud ahead of the reply (the messages log is the live region).
		this.statusEl = root.createDiv({ cls: "lva-status" });
		// First open of the chat: the setup checklist, once.
		if (!this.plugin.settings.setupShown) {
			this.plugin.settings.setupShown = true;
			void this.plugin.saveSettings();
			this.plugin.openSetup();
		}
		this.unsubscribeStatus = this.plugin.onIndexStatus(() => this.updateStatus());
		this.unsubscribeGists = this.plugin.onGistStatus(() => this.updateStatus());
		this.updateStatus();
	}

	async onClose(): Promise<void> {
		this.stop();
		// A model list still on its way must not fill a picker that is gone.
		this.modelListRequest++;
		this.recorder.cancel();
		this.unsubscribeStatus?.();
		this.unsubscribeStatus = null;
		this.unsubscribeGists?.();
		this.unsubscribeGists = null;
		this.unsubscribeBusy?.();
		this.unsubscribeBusy = null;
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

	private modelListRequest = 0;

	/**
	 * Fills the model picker: the models the agent can use, each with its size and whether it is in
	 * memory now (one request for the list, one for what is loaded). Called when the panel opens, by
	 * the refresh button and after each reply, when the chosen model has just been loaded.
	 */
	private async populateModels(notify = false): Promise<void> {
		const request = ++this.modelListRequest;
		const client = this.plugin.client;
		let models: Awaited<ReturnType<typeof client.listModels>> | null = null;
		let running: Awaited<ReturnType<typeof client.ps>> = [];
		let error = "";
		try {
			// What is loaded is a nicety: a server without /api/ps still gets its list.
			[models, running] = await Promise.all([client.listModels(), client.ps().catch(() => [])]);
		} catch (err) {
			error = (err as Error).message ?? String(err);
		}
		// A newer refresh is on its way, or the panel was closed meanwhile.
		if (request !== this.modelListRequest) return;
		// Read now, not before the requests: the user may have picked another model while they ran.
		const current = this.plugin.settings.model;
		this.modelSelect.empty();
		if (!models) {
			this.modelSelect.createEl("option", { value: current, text: current });
			this.modelSelect.value = current;
			if (notify) new Notice(t(client.provider === "ollama" ? "notice.models.unreachable.ollama" : "notice.models.unreachable.server", { error }));
			return;
		}
		const options = chatModelOptions(models, running, current);
		for (const o of options) {
			const el = this.modelSelect.createEl("option", { value: o.value, text: o.label });
			if (o.current) el.selected = true;
		}
		if (notify) {
			const n = options.filter((o) => o.usable).length;
			new Notice(t(n === 1 ? "notice.models.found.one" : "notice.models.found", { n }));
		}
	}

	private renderWelcome(): void {
		const el = this.messagesEl.createDiv({ cls: "lva-welcome" });
		el.createEl("p", { text: t("view.welcome") });
		el.createEl("p", { cls: "lva-welcome-hint", text: t("view.welcome.hint") });
		const list = el.createDiv({ cls: "lva-suggestions" });
		for (const key of SUGGESTIONS) {
			const s = t(key);
			const chip = list.createEl("button", { cls: "lva-chip", text: s });
			chip.addEventListener("click", () => this.prefill(s.endsWith("…?") || s.endsWith("…") ? s.replace(/…\??$/, "") : s));
		}
		const start = el.createDiv({ cls: "lva-suggestions lva-start" });
		const sample = start.createEl("button", { cls: "lva-chip mod-cta", text: t("view.welcome.sample") });
		sample.addEventListener("click", () => void this.plugin.trySample());
		const setup = start.createEl("button", { cls: "lva-chip", text: t("view.welcome.setup") });
		setup.addEventListener("click", () => this.plugin.openSetup());
	}

	/** Re-renders the saved conversation (if any) when the panel opens. */
	private async restoreChat(): Promise<void> {
		const messages = await this.plugin.loadChat();
		if (!messages || messages.length === 0 || this.conversation.messages.length > 0) return;
		this.conversation = { id: this.plugin.lastChatId ?? newConversation().id, messages, approveAll: false };
		this.usage = this.plugin.lastChatUsage;
		this.messagesEl.querySelector(".lva-welcome")?.remove();
		await this.renderHistory(messages);
		this.updateStatus();
		this.scrollToBottom(true);
	}

	/** Saves the conversation, with how each tool call ended, so it can be drawn again after a restart. */
	private saveChat(): void {
		recordOutcomes(this.conversation.messages, this.outcomes);
		this.plugin.saveChat(this.conversation.messages, this.conversation.id, this.usage);
	}

	private async renderHistory(messages: ChatMessage[]): Promise<void> {
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (m.role === "user") {
				if (m.content === AUTO_CONTINUE_TEXT || m.content.startsWith(GROUNDING_PREFIX) || m.content.startsWith(FOLLOW_THROUGH_TEXT) || /^Your reply was empty/.test(m.content)) {
					this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: "(auto-continued)" });
				} else {
					const user = this.messagesEl.createDiv({ cls: "lva-msg lva-user" });
					user.createDiv({ cls: "lva-bubble", text: m.content.split("\n\n(The user attached")[0] });
				}
			} else if (m.role === "assistant") {
				const root = this.messagesEl.createDiv({ cls: "lva-msg lva-assistant" });
				if (m.content.trim()) {
					await this.renderMarkdown(m.content, root.createDiv({ cls: "lva-bubble lva-markdown" }));
					addAnswerActions(this, root, m.content);
				}
				// Each card as it ended: failed calls red, a call the turn never finished marked as stopped,
				// and the Undo button of every write that is still in the change history.
				for (const restored of restoredCards(messages, i)) {
					const card = createToolCard(root, restored.call, restored.state === "ok" ? "lva-tool-ok" : restored.state === "error" ? "lva-tool-error" : "lva-tool-unfinished");
					if (restored.result === null) card.querySelector(".lva-tool-args")?.setText(t("view.tool.stopped"));
					else fillToolResult(card, restored.call, restored.result, restored.state === "ok");
					for (const id of restored.changes) {
						const change = this.plugin.undo.byId(id);
						// The id alone is not proof: a history file that was reset numbers its changes from 1 again.
						if (change && change.chat === this.conversation.id) addUndoButton(this.plugin, card, change);
					}
				}
			}
		}
		this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: t("view.restored") });
	}

	private resetConversation(): void {
		this.stop();
		this.quiz = null;
		this.quizSources.clear();
		void this.plugin.clearChat();
		this.conversation = newConversation();
		this.syncApproveAll();
		this.usage = null;
		this.messagesEl.empty();
		this.follow.jump();
		this.syncJump();
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
		this.sendBtn.setAttribute("aria-label", running ? t("view.stop") : t("view.send"));
		this.sendBtn.toggleClass("lva-stop", running);
	}

	/** Stops this view's running turn or quiz step. The lease is kept until that code has unwound, so it can tell it was stopped. */
	private stop(): void {
		this.lease?.stop();
	}

	/** Says why a message cannot be sent right now (the text stays in the message box). */
	private noticeBusy(): void {
		const holder = this.plugin.busy.holder;
		new Notice(holder?.owner === "job" ? t("notice.jobRunning", { job: holder.label }) : t("notice.wait"));
	}

	/** Shows the running scheduled job, if any, with its Stop button ("Stopping…" once it was pressed). */
	private syncJobBar(): void {
		const holder = this.plugin.busy.holder;
		const job = holder?.owner === "job" ? holder : null;
		this.jobBarEl.toggle(job !== null);
		if (!job) return;
		this.jobBarText.setText(t(job.stopped ? "job.stopping" : "job.running", { job: job.label }));
		this.jobStopBtn.disabled = job.stopped;
	}

	/** Shows or hides the "written without a diff" bar to match this chat's approve-all and the global setting. */
	private syncApproveAll(): void {
		const why = unattendedWrites(this.conversation.approveAll, this.plugin.settings.autoApproveEdits);
		if (why === this.approveAllShown) return;
		this.approveAllShown = why;
		if (why) this.approveAllText.setText(t(why === "chat" ? "view.approveAll.chat" : "view.approveAll.setting"));
		this.approveAllEl.toggle(why !== null);
	}

	/** One click: diffs are shown again, from the next change on (also of a turn that is running). */
	private turnOffApproveAll(): void {
		this.conversation.approveAll = false;
		if (this.plugin.settings.autoApproveEdits) {
			this.plugin.settings.autoApproveEdits = false;
			void this.plugin.saveSettings();
		}
		this.syncApproveAll();
		this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: t("view.approveAll.offNote") });
		this.scrollToBottom();
	}

	private updateStatus(extra?: string): void {
		this.syncApproveAll();
		const s = this.plugin.index.status();
		const parts: string[] = [];
		if (extra) parts.push(extra);
		if (!s.enabled) parts.push(t("view.status.keyword"));
		else if (s.building) parts.push(t("view.status.indexing", { done: s.indexedFiles, pending: s.pending }));
		else if (s.lastError) parts.push(t("view.status.indexError", { error: s.lastError }));
		else parts.push(t("view.status.index", { notes: s.indexedFiles, chunks: s.totalChunks }));
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
			parts.push(t("view.status.context", { used: formatTokens(used), total: formatTokens(this.usage.numCtx), pct }));
		}
		this.statusEl.setText(parts.join(" · "));
		this.statusEl.toggleClass("lva-ctx-warn", warn);
	}

	/**
	 * Follows what was just added to the conversation, when the reader is at the bottom. When they
	 * have scrolled up, the list stays where it is and the "jump to latest" button is shown. `force`
	 * goes to the bottom regardless (the user's own message, or the button).
	 */
	private scrollToBottom(force = false): void {
		if (force) this.follow.jump();
		if (this.follow.contentAdded()) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		this.syncJump();
	}

	private syncJump(): void {
		this.jumpBtn.toggle(this.follow.showJump);
		this.jumpBtn.toggleClass("lva-jump-new", this.follow.hasUnseen);
		this.jumpBtn.setAttribute("aria-label", t(this.follow.hasUnseen ? "view.jump.new" : "view.jump"));
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
			case "quiz":
				await this.plugin.startQuiz(this);
				break;
			case "concepts":
				await this.plugin.suggestConceptLinks();
				break;
			case "history":
				this.plugin.showHistory();
				break;
			case "review":
				await this.plugin.reviewPending();
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
				this.scrollToBottom(true);
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
		this.saveChat();
		this.scrollToBottom(true);
		return root;
	}

	/**
	 * Shows the gardener's report as an assistant message with one button per section. The report
	 * joins the conversation, so "repoint the first three broken links" typed by hand works too.
	 * Nothing is written to the vault until a button is used, and then each change is a diff.
	 */
	async showGardenReport(markdown: string, fixes: GardenFix[], report: GardenReport, legacyNote: boolean): Promise<void> {
		if (this.running || this.gardening) {
			new Notice(t("notice.wait"));
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
			const result = await this.plugin.applyGardenAction(fix.action, report, this.conversation.messages.length, this.conversation.id);
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
		if (!text || this.running || this.gardening || this.quizBusy) return;
		const slash = parseSlash(text);
		if (slash) {
			this.inputEl.value = "";
			await this.runSlash(slash.id);
			return;
		}
		// A panel restored with the workspace was never "opened": the first message is when a missing server is reported.
		void this.plugin.checkOllamaOnce();
		// Everything below calls the model, one job at a time: a scheduled job may be running.
		// (Ending a quiz needs no model.) The text stays in the box when it cannot be sent.
		if (this.plugin.busy.busy && !(this.quiz && QUIZ_END.test(text))) {
			this.noticeBusy();
			return;
		}
		if (this.quiz) {
			this.inputEl.value = "";
			await this.answerQuiz(text);
			return;
		}
		if (parseQuizRequest(text, new Date())) {
			this.inputEl.value = "";
			await this.startQuiz(text, this.plugin.settings.quizQuestions);
			return;
		}
		const lease = this.plugin.busy.acquire("chat");
		if (!lease) {
			this.noticeBusy();
			return;
		}
		this.lease = lease;
		/** The changes the agent reports for this message. Not looked up by turn number: the agent
		 * numbers the turn after compacting the history, so the view cannot know that number. */
		const made: ChangeRecord[] = [];
		/** The reply being drawn; null between the model's steps. In an object so the code after the turn can reach it. */
		const live: { turn: TurnRenderer | null } = { turn: null };
		const started = Date.now();
		let calls = 0;
		let failed = false;
		/** No model call was made in this chat yet: the first one tells how large the fixed part of the prompt is. */
		const firstCall = this.usage === null;
		const tp = new TurnProgress(started, {
			contextTokens: this.usage ? this.usage.promptTokens + this.usage.completionTokens : this.prefixTokens,
			messageChars: text.length,
		});
		let askingLoaded = false;
		/** Whether the chat model is in memory, so a wait of a minute says "Loading the model…" instead of nothing; asked again while it loads. */
		const askLoaded = () => {
			if (askingLoaded || this.plugin.client.provider !== "ollama") return;
			askingLoaded = true;
			this.plugin.client
				.ps()
				.then((running) => tp.setLoaded(running.some((r) => sameModel(r.name, this.plugin.settings.model))))
				// A server that cannot say: the line says "Reading the prompt…".
				.catch(() => undefined)
				.finally(() => {
					askingLoaded = false;
				});
		};
		const progress = () => {
			const now = Date.now();
			const phase = tp.phase(now);
			if (phase.kind === "loading") askLoaded();
			const parts = [phaseText(phase)];
			if (calls > 0) parts.push(t("view.status.calls", { calls }));
			parts.push(t("view.status.secs", { secs: Math.round((now - started) / 1000) }));
			this.updateStatus(parts.join(" · "));
		};
		/** What the model is streaming right now, so the status line changes when it does and not on every piece. */
		let streaming: "thinking" | "content" | null = null;
		const piece = (kind: "thinking" | "content", chars: number) => {
			tp.delta(Date.now(), kind, chars);
			if (streaming === kind) return;
			streaming = kind;
			progress();
		};
		let ticker: number | null = null;

		// From here to the `finally` that gives the gate back, everything is inside the try: a
		// lease that leaked would leave the chat refusing messages until Obsidian is restarted.
		try {
			this.messagesEl.querySelector(".lva-welcome")?.remove();
			this.inputEl.value = "";
			this.autoGrow();
			this.setSendState(true);
			ticker = window.setInterval(progress, 1000);
			const user = this.messagesEl.createDiv({ cls: "lva-msg lva-user" });
			user.createDiv({ cls: "lva-bubble", text });
			const { message, attached } = attach ? await attachMentions(text, this.plugin.vault, this.plugin.settings.maxToolResultChars * 2) : { message: text, attached: [] as string[] };
			if (attached.length) {
				user.createDiv({ cls: "lva-attached", text: `Attached: ${attached.map((p) => p.replace(/\.md$/i, "")).join(", ")}` });
			}
			// The reader's own message: always shown, wherever they had scrolled to.
			this.scrollToBottom(true);
			// The notes attached to the message are read by the model too.
			tp.added(message.length - text.length);
			askLoaded();
			await this.plugin.agent.run(
				this.conversation,
				message,
				{
					onStatus: () => progress(),
					onAssistantStart: () => {
						live.turn = new TurnRenderer(this, this.messagesEl, this.plugin);
						tp.stepStart();
						streaming = null;
						progress();
						this.scrollToBottom();
					},
					onThinkingDelta: (d) => {
						piece("thinking", d.length);
						live.turn?.appendThinking(d);
						this.scrollToBottom();
					},
					// The renderer says when it has drawn something (contentAdded): the text is not on screen yet here.
					onAssistantDelta: (d) => {
						piece("content", d.length);
						live.turn?.appendContent(d);
					},
					onAssistantDone: (m) => {
						tp.stepDone(Date.now());
						void live.turn?.finish(m);
					},
					onToolStart: (call) => {
						live.turn?.toolStart(call);
						this.scrollToBottom();
					},
					onToolDone: (call, result, ok) => {
						calls++;
						this.outcomes.set(call, { ...this.outcomes.get(call), ok });
						// Only the tool's name goes into the log: results and errors can quote notes.
						if (!ok) log.warn(`Tool ${call.function.name} returned an error`);
						tp.added(result.length);
						live.turn?.toolDone(call, result, ok);
						this.scrollToBottom();
					},
					onChange: (change, call) => {
						made.push(change);
						// The first write after "Approve all" was granted: show the bar at once.
						this.syncApproveAll();
						const seen = this.outcomes.get(call);
						this.outcomes.set(call, { ok: seen?.ok ?? true, changes: [...(seen?.changes ?? []), change.id] });
						live.turn?.attachUndo(call, change);
					},
					onUsage: (u) => {
						if (firstCall && this.usage === null) this.prefixTokens = Math.max(0, u.promptTokens - Math.ceil(message.length / 3.2));
						this.usage = u;
						tp.usage(u);
						progress();
					},
					onAutoContinue: (nudge) => {
						this.messagesEl.createDiv({
							cls: "lva-msg lva-note",
							text: nudge.startsWith(GROUNDING_PREFIX) ? t("view.groundingNudge") : t("view.autoContinued"),
						});
						this.scrollToBottom();
					},
				},
				lease.signal,
			);
			if (!lease.stopped && (await this.plugin.countAnswer())) this.showSurvey();
		} catch (err) {
			if (!lease.stopped) {
				failed = true;
				const message = (err as Error).message ?? String(err);
				log.error(`Chat turn failed: ${message}`);
				const errEl = this.messagesEl.createDiv({ cls: "lva-msg lva-error", attr: { role: "alert" } });
				errEl.createDiv({ cls: "lva-bubble", text: message });
				const report = errEl.createEl("button", { cls: "lva-chip", text: t("view.report") });
				report.addEventListener("click", () => this.plugin.reportProblem(message));
			}
			this.offerPartialUndo(made);
		} finally {
			// First of all: the lease still says whether it was stopped after it is released.
			lease.release();
			this.lease = null;
			if (ticker !== null) window.clearInterval(ticker);
			if (lease.stopped) {
				// What was being drawn when Stop was pressed is left as it is, not as if it were still coming.
				live.turn?.abandon();
				this.offerPartialUndo(made);
				this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: t("view.stopped") });
			}
			// How it went: the wait for the first words, the speed, the size of the prompt.
			const summary = tp.summary(Date.now());
			const stats = summaryText(summary);
			// Not announced: a screen reader has just been given the reply itself.
			if (stats) this.messagesEl.createDiv({ cls: "lva-stats", text: stats, attr: { "aria-live": "off" } });
			// Numbers only in the log, never what was asked or answered.
			log.info(`Turn ${lease.stopped ? "stopped" : failed ? "failed" : "finished"}: ${calls} tool calls, ${summary.steps} model calls${stats ? `, ${stats}` : ` in ${formatDuration(summary.totalMs)}`}`);
			if (!lease.stopped) this.notifyIfAway(summary.totalMs, failed);
			this.setSendState(false);
			this.saveChat();
			void this.plugin.checkPlacementOnce();
			// The picker says which model is loaded; after a reply that is the one just used.
			void this.populateModels();
			this.updateStatus();
			this.scrollToBottom();
		}
	}

	/**
	 * A long turn that ends while the user is in another application: a notice that waits for them
	 * (it stays until Obsidian has the focus again, and a few seconds more).
	 */
	private notifyIfAway(totalMs: number, failed: boolean): void {
		const win = this.containerEl.win;
		if (!shouldNotify(totalMs, win.document.hasFocus())) return;
		const notice = new Notice(t(failed ? "notice.turnFailed" : "notice.turnDone", { time: formatDuration(totalMs) }), 0);
		const back = () => {
			win.removeEventListener("focus", back);
			win.setTimeout(() => notice.hide(), 8000);
		};
		win.addEventListener("focus", back);
	}

	/** Shows/hides the mic: it needs Lecture Companion's transcription. */
	private updateMic(): void {
		if (!this.micBtn) return;
		this.micBtn.toggle(this.plugin.lectureCompanion() !== null);
	}

	private async toggleMic(): Promise<void> {
		const btn = this.micBtn;
		if (!btn) return;
		const lc = this.plugin.lectureCompanion();
		if (!lc) {
			new Notice("Voice input uses Lecture Companion's transcription; install and enable Lecture Companion to dictate.", 8000);
			this.updateMic();
			return;
		}
		if (!this.recorder.recording) {
			try {
				await this.recorder.start();
			} catch (err) {
				new Notice(`Cannot use the microphone: ${(err as Error).message}`, 8000);
				return;
			}
			btn.addClass("lva-mic-on");
			btn.setAttribute("aria-label", t("view.mic.stop"));
			return;
		}
		btn.removeClass("lva-mic-on");
		btn.addClass("lva-mic-busy");
		btn.disabled = true;
		btn.setAttribute("aria-label", t("view.mic.busy"));
		try {
			const wav = await this.recorder.stop();
			const text = (await lc.transcribe(wav)).trim();
			if (text) {
				const cur = this.inputEl.value;
				this.inputEl.value = cur && !/\s$/.test(cur) ? `${cur} ${text}` : cur + text;
				this.inputEl.focus();
			} else new Notice("Heard nothing to transcribe.");
		} catch (err) {
			new Notice(`Transcription failed: ${(err as Error).message}`, 8000);
		} finally {
			btn.removeClass("lva-mic-busy");
			btn.disabled = false;
			btn.setAttribute("aria-label", t("view.mic"));
		}
	}

	/**
	 * After a turn that failed or was stopped: the changes it had already made are complete (each was
	 * one approved diff), but the task is half done, so offer to take them all back.
	 */
	private offerPartialUndo(made: ChangeRecord[]): void {
		const changes = stillApplied(made);
		// A failed turn that was also stopped gets here twice.
		if (changes.length === 0 || this.partialOffered.has(made)) return;
		this.partialOffered.add(made);
		const note = this.messagesEl.createDiv({ cls: "lva-msg lva-note" });
		note.createSpan({ text: `${t("view.partial", { n: changes.length })} ` });
		const btn = note.createEl("button", { cls: "lva-chip", text: t("view.partial.undo") });
		btn.addEventListener("click", () => {
			btn.disabled = true;
			void (async () => {
				// Exactly this turn's writes, minus any undone from a tool card since: asking the
				// history for the turn would also return those undos and put the edits back.
				const pending = stillApplied(made);
				let done = 0;
				for (const change of pending) {
					if (change.undone) continue;
					if (!(await this.plugin.revert(change))) break;
					done++;
				}
				if (pending.length > 1) new Notice(`Undid ${done} of ${pending.length} changes.`);
			})();
		});
	}

	/** The three sample questions as buttons, after "Try it on sample notes". */
	showSampleQuestions(): void {
		this.messagesEl.querySelector(".lva-welcome")?.remove();
		const root = this.messagesEl.createDiv({ cls: "lva-msg lva-assistant" });
		root.createDiv({ cls: "lva-bubble", text: "The sample notes are ready. Ask one of these; the answer cites the notes and links the paragraph:" });
		const row = root.createDiv({ cls: "lva-fixes" });
		for (const q of SAMPLE_QUESTIONS) {
			const chip = row.createEl("button", { cls: "lva-chip", text: q });
			chip.addEventListener("click", () => {
				if (this.running) return;
				void this.send(q);
			});
		}
		this.scrollToBottom();
	}

	/** The one-question survey, shown once after a few answers. Its buttons only open a GitHub page. */
	private showSurvey(): void {
		const card = this.messagesEl.createDiv({ cls: "lva-msg lva-note lva-survey", attr: { role: "group", "aria-label": t("survey.question") } });
		card.createDiv({ text: t("survey.question") });
		const row = card.createDiv({ cls: "lva-fixes" });
		const answer = (label: string | null, problem = false) => {
			card.empty();
			card.createDiv({ text: label ? t("survey.thanks") : "" });
			if (problem) this.plugin.reportProblem();
			void this.plugin.finishSurvey(problem ? null : label);
		};
		row.createEl("button", { cls: "lva-chip", text: t("survey.great") }).addEventListener("click", () => answer(t("survey.great")));
		row.createEl("button", { cls: "lva-chip", text: t("survey.problems") }).addEventListener("click", () => answer(t("survey.problems"), true));
		row.createEl("button", { cls: "lva-chip", text: t("survey.notUseful") }).addEventListener("click", () => answer(t("survey.notUseful")));
		row.createEl("button", { cls: "lva-chip", text: t("survey.dismiss") }).addEventListener("click", () => answer(null));
		this.scrollToBottom();
	}

	private addUser(text: string): void {
		this.messagesEl.querySelector(".lva-welcome")?.remove();
		this.messagesEl.createDiv({ cls: "lva-msg lva-user" }).createDiv({ cls: "lva-bubble", text });
		this.scrollToBottom(true);
	}

	private async addAssistant(markdown: string): Promise<void> {
		this.messagesEl.querySelector(".lva-welcome")?.remove();
		const root = this.messagesEl.createDiv({ cls: "lva-msg lva-assistant" });
		await this.renderMarkdown(markdown, root.createDiv({ cls: "lva-bubble lva-markdown" }));
		this.scrollToBottom();
	}

	private remember(userText: string, markdown: string): void {
		this.conversation.messages.push({ role: "user", content: userText }, { role: "assistant", content: markdown });
		this.saveChat();
	}

	/**
	 * Starts a quiz from "Quiz me on <topic> since <date>": picks the notes (Lecture Companion's
	 * lectures of that course when it is installed, else notes named after the topic, else a search),
	 * has the model write questions from them, and asks the first.
	 */
	async startQuiz(text: string, count: number): Promise<void> {
		if (this.running || this.gardening || this.quizBusy) {
			new Notice(t("notice.wait"));
			return;
		}
		const lease = this.plugin.busy.acquire("quiz");
		if (!lease) {
			this.noticeBusy();
			return;
		}
		this.lease = lease;
		this.quizBusy = true;
		const started = Date.now();
		let failed = false;
		try {
			const req = parseQuizRequest(text, new Date()) ?? { topic: text };
			this.addUser(text);
			this.setSendState(true);
			this.updateStatus("Writing quiz questions…");
			const lc = this.plugin.lectureCompanion();
			let paths = selectQuizNotes(this.plugin.vault.listNotes(), req, lc?.lectures() ?? []);
			if (paths.length === 0 && req.topic) {
				const hits = await this.plugin.hybridSearch(req.topic, 10);
				if (lease.stopped) return;
				const since = req.since ?? "0000-00-00";
				paths = hits.map((h) => h.path).filter((p) => {
					const n = this.plugin.vault.listNotes().find((x) => x.path === p);
					const date = /(\d{4}-\d{2}-\d{2})/.exec(p)?.[1] ?? (n ? new Date(n.mtime).toISOString().slice(0, 10) : "");
					return date >= since;
				});
			}
			if (paths.length === 0) {
				const md = `I found no notes${req.topic ? ` on ${req.topic}` : ""}${req.since ? ` since ${req.since}` : ""} to quiz you on. Try a course or folder name, or an earlier date.`;
				await this.addAssistant(md);
				this.remember(text, md);
				return;
			}
			this.quizSources.clear();
			for (const p of paths) this.quizSources.set(p, await this.plugin.vault.read(p));
			if (lease.stopped) return;
			const questions = await this.plugin.quiz.questions(req.topic, Array.from(this.quizSources, ([path, content]) => ({ path, content })), count, lease.signal);
			// Stopped while the model was writing: whatever came back is not a quiz.
			if (lease.stopped) return;
			if (questions.length === 0) {
				const md = "The model did not write any questions I could check against your notes. Try again, or a narrower topic.";
				await this.addAssistant(md);
				this.remember(text, md);
				return;
			}
			this.quiz = new QuizSession(req.topic, questions, req.since);
			const from = paths.map((p) => `[[${p.replace(/\.md$/i, "")}]]`);
			const md = [
				`Quiz on ${req.topic || "your notes"}${req.since ? ` since ${req.since}` : ""}: ${questions.length} questions from ${paths.length} note${paths.length === 1 ? "" : "s"} (${from.slice(0, 6).join(", ")}${from.length > 6 ? ", …" : ""}). Answer in your own words; type *skip* to pass or *stop* to end. Written in ${Math.round((Date.now() - started) / 1000)} s.`,
				"",
				questionMarkdown(this.quiz),
			].join("\n");
			await this.addAssistant(md);
			this.remember(text, md);
		} catch (err) {
			if (!lease.stopped) {
				failed = true;
				const message = (err as Error).message ?? String(err);
				this.messagesEl.createDiv({ cls: "lva-msg lva-error" }).createDiv({ cls: "lva-bubble", text: message });
			}
		} finally {
			lease.release();
			this.lease = null;
			this.quizBusy = false;
			if (lease.stopped) {
				this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: t("view.stopped") });
				this.scrollToBottom();
			} else this.notifyIfAway(Date.now() - started, failed);
			this.setSendState(false);
			this.updateStatus();
		}
	}

	/** Grades one answer against its source, shows the verdict with the citation, then the next question or the end. */
	private async answerQuiz(text: string): Promise<void> {
		const quiz = this.quiz;
		const q = quiz?.current();
		if (!quiz || !q) return;
		if (QUIZ_END.test(text.trim())) {
			this.addUser(text);
			await this.finishQuiz(text, "");
			return;
		}
		const lease = this.plugin.busy.acquire("quiz");
		if (!lease) {
			// Not graded and not shown yet: back into the message box, to send again.
			this.noticeBusy();
			this.inputEl.value = text;
			return;
		}
		this.lease = lease;
		this.quizBusy = true;
		let graded = false;
		try {
			this.addUser(text);
			this.setSendState(true);
			this.updateStatus("Grading…");
			const source = this.quizSources.get(q.source) ?? "";
			const grade = isNonAnswer(text) ? { verdict: "wrong" as const, feedback: "Skipped." } : await this.plugin.quiz.grade(q, text, source.slice(0, 6000), lease.signal);
			// Stopped while grading: nothing is recorded, the question stays the current one.
			if (lease.stopped) return;
			graded = true;
			const result = quiz.record(text, grade.verdict, grade.feedback);
			const md = resultMarkdown(result);
			if (quiz.done()) {
				await this.finishQuiz(text, md);
				return;
			}
			const next = `${md}\n\n${questionMarkdown(quiz)}`;
			await this.addAssistant(next);
			this.remember(text, next);
		} catch (err) {
			if (!lease.stopped) new Notice(`Grading failed: ${(err as Error).message}`, 8000);
		} finally {
			lease.release();
			this.lease = null;
			this.quizBusy = false;
			if (lease.stopped && !graded) {
				this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: t("view.quiz.stoppedGrading") });
				this.scrollToBottom();
			}
			this.setSendState(false);
			this.updateStatus();
		}
	}

	/** The score, and the missed questions written (after a diff) to the topic's review note. */
	private async finishQuiz(userText: string, lastResult: string): Promise<void> {
		const quiz = this.quiz;
		this.quiz = null;
		if (!quiz) return;
		const missed = quiz.missed();
		const lines = [lastResult, lastResult ? "" : "", `**Quiz over: ${quiz.score()}.**`].filter((l, i) => l || i > 0);
		if (missed.length) {
			const path = reviewNotePath(this.plugin.settings.quizReviewFolder, quiz.topic);
			const existing = this.plugin.vault.exists(path) ? await this.plugin.vault.read(path) : null;
			const after = renderReview(existing, quiz.topic, new Date().toISOString().slice(0, 10), missed);
			const written = await this.plugin.writeWithApproval(
				{ tool: existing === null ? "create_note" : "append_to_note", path, before: existing ?? "", after, summary: `Add ${missed.length} missed question${missed.length === 1 ? "" : "s"} to ${path}` },
				this.conversation.id ?? "plugin",
				this.conversation.messages.length,
			);
			lines.push(written ? `The ${missed.length} question${missed.length === 1 ? "" : "s"} to review ${missed.length === 1 ? "is" : "are"} in [[${path.replace(/\.md$/i, "")}]].` : "The review note was not written.");
		} else if (quiz.results.length) lines.push("Nothing to review.");
		const md = lines.join("\n").trim();
		await this.addAssistant(md);
		this.remember(userText, md);
	}

	/** Says `text` to screen readers once, without showing it. */
	announce(text: string): void {
		this.announcerEl.setText(text);
	}

	/** Called after something was added to the conversation: follows it when the reader is at the end. */
	contentAdded(): void {
		this.scrollToBottom();
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

	/** Puts `text` at the cursor (over the selection) of the note the user was last in; the chat has the focus when this is clicked. */
	insertAtCursor(text: string): void {
		const view = this.plugin.activeEditorView();
		if (!view) {
			new Notice(t("notice.insert.noNote"));
			return;
		}
		view.editor.replaceSelection(text);
		// Named, because the note is not the panel the user is looking at.
		new Notice(t("notice.insert.done", { note: view.file?.basename ?? "" }));
	}
}

/** What ends a quiz when typed as an answer; needs no model call. */
const QUIZ_END = /^(stop|quit|end( the)? quiz|cancel|done)[.!]*$/i;

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
	/** Draws the reply block by block while it arrives, so finished paragraphs are not drawn again. */
	private stream: StreamRenderer<Node>;
	/** Renders run one after another; this is the last one. */
	private work: Promise<void> = Promise.resolve();
	private rendering = false;
	/** Text arrived while a render was running. */
	private dirty = false;
	private lastRenderMs = 0;
	/** The reply is finished or was stopped: nothing more is drawn from the stream. */
	private closed = false;

	constructor(
		private view: AgentView,
		parent: HTMLElement,
		private plugin: LocalVaultAgentPlugin,
	) {
		this.root = parent.createDiv({ cls: "lva-msg lva-assistant" });
		// Not announced while it is being written; the finished reply is read once (see finish).
		this.contentEl = this.root.createDiv({ cls: "lva-bubble lva-markdown lva-streaming", attr: { "aria-live": "off" } });
		const contentEl = this.contentEl;
		this.stream = new StreamRenderer<Node>({
			render: async (markdown) => {
				// Rendered off screen and moved in afterwards, so the bubble never shows a half-built block.
				const holder = createDiv();
				await view.renderMarkdown(markdown, holder);
				return Array.from(holder.childNodes);
			},
			append: (nodes) => contentEl.append(...nodes),
			remove: (nodes) => {
				for (const n of nodes) n.parentNode?.removeChild(n);
			},
			same: (a, b) => a.isEqualNode(b),
		});
	}

	appendThinking(delta: string): void {
		this.thinking += delta;
		if (!this.plugin.settings.showThinking) return;
		if (!this.thinkingEl) {
			this.thinkingEl = this.root.createEl("details", { cls: "lva-thinking", attr: { "aria-live": "off" } });
			this.thinkingEl.open = true;
			this.thinkingEl.createEl("summary", { text: "Thinking…" });
			this.thinkingBody = this.thinkingEl.createDiv({ cls: "lva-thinking-body" });
			this.root.insertBefore(this.thinkingEl, this.contentEl);
		}
		this.thinkingBody!.setText(this.thinking);
	}

	appendContent(delta: string): void {
		this.content += delta;
		this.schedule();
	}

	/** Draws what has arrived, soon: not more often than every 120 ms, and less often when drawing is slow. */
	private schedule(): void {
		if (this.closed) return;
		if (this.rendering) {
			this.dirty = true;
			return;
		}
		if (this.renderTimer !== null) return;
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			void this.renderNow();
		}, nextRenderDelay(this.lastRenderMs));
	}

	private async renderNow(): Promise<void> {
		this.rendering = true;
		this.dirty = false;
		const started = performance.now();
		const text = this.content;
		await this.enqueue(async () => {
			if (!this.closed) await this.stream.update(text);
		});
		this.lastRenderMs = performance.now() - started;
		this.rendering = false;
		if (this.closed) return;
		this.view.contentAdded();
		if (this.dirty) this.schedule();
	}

	/** Runs `job` after every render started before it: two renders at once would each place their own nodes. */
	private enqueue(job: () => Promise<void>): Promise<void> {
		this.work = this.work.then(job).catch((err) => log.warn(`Drawing the reply failed: ${(err as Error).message ?? String(err)}`));
		return this.work;
	}

	/** Nothing more is drawn from the stream; a render that is under way still completes. */
	private close(): void {
		this.closed = true;
		if (this.renderTimer !== null) {
			window.clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
	}

	async finish(message: ChatMessage): Promise<void> {
		this.close();
		if (this.thinkingEl) {
			this.thinkingEl.open = false;
			this.thinkingEl.querySelector("summary")!.setText("Thinking (click to show)");
		}
		this.content = message.content;
		this.contentEl.removeClass("lva-streaming");
		if (this.content.trim()) {
			// The whole reply, rendered once more as one text; what is on screen and already matches stays (and keeps a selection).
			const text = this.content;
			await this.enqueue(() => this.stream.finish(text));
			addAnswerActions(this.view, this.root, this.content);
			this.view.announce(this.contentEl.textContent ?? "");
		} else {
			// A pure tool-call turn: nothing to show in the bubble.
			this.contentEl.remove();
		}
		this.view.contentAdded();
	}

	toolStart(call: ToolCall): void {
		this.toolCards.set(call, createToolCard(this.root, call, "lva-tool-running"));
	}

	/**
	 * The turn was stopped while this reply was being drawn: show the text that had arrived without
	 * the "still writing" cursor, and mark tool calls that never answered as stopped instead of running.
	 */
	abandon(): void {
		if (this.contentEl.hasClass("lva-streaming")) {
			this.contentEl.removeClass("lva-streaming");
			const text = this.content;
			this.close();
			if (text.trim()) void this.enqueue(() => this.stream.finish(text));
			else this.contentEl.remove();
		}
		for (const card of this.toolCards.values()) {
			if (!card.hasClass("lva-tool-running")) continue;
			card.removeClass("lva-tool-running");
			card.addClass("lva-tool-unfinished");
			card.querySelector(".lva-tool-args")?.setText(t("view.tool.stopped"));
		}
	}

	/** Adds an "Undo" button to the tool card whose write produced `change`. */
	attachUndo(call: ToolCall, change: ChangeRecord): void {
		const card = this.toolCards.get(call);
		if (card) addUndoButton(this.plugin, card, change);
	}

	toolDone(call: ToolCall, result: string, ok: boolean): void {
		const card = this.toolCards.get(call);
		if (!card) return;
		card.removeClass("lva-tool-running");
		card.addClass(ok ? "lva-tool-ok" : "lva-tool-error");
		fillToolResult(card, call, result, ok);
	}
}

/** Copy and "Insert at cursor" under an answer. */
function addAnswerActions(view: AgentView, root: HTMLElement, content: string): void {
	const actions = root.createDiv({ cls: "lva-actions" });
	const copy = actions.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": t("view.copy") } });
	setIcon(copy, "copy");
	copy.addEventListener("click", () => {
		void navigator.clipboard.writeText(content);
		new Notice("Copied.");
	});
	const insert = actions.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": t("view.insert") } });
	setIcon(insert, "file-input");
	insert.addEventListener("click", () => view.insertAtCursor(content));
}

/** A collapsed card for one tool call: icon, sentence, room for the result summary, and the raw arguments inside. */
function createToolCard(parent: HTMLElement, call: ToolCall, stateClass: string): HTMLDetailsElement {
	const card = parent.createEl("details", { cls: `lva-tool ${stateClass}` });
	const summary = card.createEl("summary");
	const icon = summary.createSpan({ cls: "lva-tool-icon" });
	setToolIcon(icon, call.function.name);
	summary.createSpan({ cls: "lva-tool-name", text: describeCall(call) });
	summary.createSpan({ cls: "lva-tool-args", text: "" });
	const body = card.createDiv({ cls: "lva-tool-body" });
	body.createEl("pre", { cls: "lva-tool-pre", text: JSON.stringify(call.function.arguments, null, 2) });
	return card;
}

/** The result on a card: a few words in the summary line, the first 3000 characters inside. */
function fillToolResult(card: HTMLElement, call: ToolCall, result: string, ok: boolean): void {
	card.querySelector(".lva-tool-args")?.setText(ok ? describeResult(call, result) : t("view.tool.failed"));
	card.querySelector(".lva-tool-body")?.createEl("pre", {
		cls: "lva-tool-pre lva-tool-result",
		text: result.length > 3000 ? result.slice(0, 3000) + "\n…" : result,
	});
}

/** An "Undo" button on the card of the call that made `change`; already "Undone" when it was taken back. */
function addUndoButton(plugin: LocalVaultAgentPlugin, card: HTMLElement, change: ChangeRecord): void {
	const summary = card.querySelector("summary");
	if (!summary) return;
	const btn = summary.createEl("button", { cls: "lva-undo-btn", text: t("view.undo"), attr: { "aria-label": `${t("view.undo")}: ${change.path}` } });
	const markUndone = () => {
		btn.disabled = true;
		btn.setText(t("view.undone"));
	};
	if (change.undone) markUndone();
	btn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		void plugin.revert(change).then((done) => {
			if (done) markUndone();
		});
	});
}

/** Draws a tool's icon; when this Obsidian is older than the icon, the one every version has. */
function setToolIcon(el: HTMLElement, tool: string): void {
	const { icon, fallback } = iconFor(tool);
	setIcon(el, icon);
	if (!el.firstChild) setIcon(el, fallback);
}
