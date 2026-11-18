import { sameModel } from "./ollama";
import { ItemView, MarkdownRenderer, MarkdownView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type LocalVaultAgentPlugin from "./main";
import { AUTO_CONTINUE_TEXT, GROUNDING_PREFIX, newConversation, type Conversation } from "./agent";
import { ComposerSuggest } from "./composer-suggest";
import type { GardenFix, GardenReport } from "./gardener";
import { HELP_TEXT, attachMentions, matchCommands, matchNotes, parseSlash } from "./mentions";
import { conversationToMarkdown } from "./transcript";
import { QuizSession, isNonAnswer, parseQuizRequest, questionMarkdown, renderReview, resultMarkdown, reviewNotePath, selectQuizNotes } from "./quiz";
import { VoiceRecorder } from "./voice";
import { t, type I18nKey } from "./i18n";
import { log } from "./log";
import { SAMPLE_QUESTIONS } from "./sample";
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
	private abort: AbortController | null = null;
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
	private suggest: ComposerSuggest | null = null;
	/** The quiz in progress: while set, the composer's messages are answers, graded instead of sent to the agent. */
	private quiz: QuizSession | null = null;
	private quizSources = new Map<string, string>();
	private quizBusy = false;
	private micBtn: HTMLButtonElement | null = null;
	private recorder = new VoiceRecorder();

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
		// A live region: screen readers announce new messages as they arrive.
		this.messagesEl = root.createDiv({ cls: "lva-messages", attr: { role: "log", "aria-live": "polite", "aria-label": t("view.messages") } });
		this.renderWelcome();
		void this.restoreChat();

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
		this.inputEl.addEventListener("focus", () => this.updateMic());
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
		this.recorder.cancel();
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
		this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: t("view.restored") });
	}

	private resetConversation(): void {
		this.stop();
		this.quiz = null;
		this.quizSources.clear();
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
		this.sendBtn.setAttribute("aria-label", running ? t("view.stop") : t("view.send"));
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
			parts.push(t("view.status.context", { used: fmtK(used), total: fmtK(this.usage.numCtx), pct }));
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
		this.plugin.saveChat(this.conversation.messages, this.conversation.id);
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
		/** The changes the agent reports for this message. Not looked up by turn number: the agent
		 * numbers the turn after compacting the history, so the view cannot know that number. */
		const made: ChangeRecord[] = [];
		let turn: TurnRenderer | null = null;
		const started = Date.now();
		let calls = 0;
		const progress = () => this.updateStatus(t("view.status.working", { calls, secs: Math.round((Date.now() - started) / 1000) }));
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
						// Only the tool's name goes into the log: results and errors can quote notes.
						if (!ok) log.warn(`Tool ${call.function.name} returned an error`);
						turn?.toolDone(call, result, ok);
						this.scrollToBottom();
					},
					onChange: (change, call) => {
						made.push(change);
						turn?.attachUndo(call, change);
					},
					onUsage: (u) => {
						this.usage = u;
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
				this.abort.signal,
			);
			log.info(`Turn finished: ${calls} tool calls in ${Math.round((Date.now() - started) / 1000)} s${this.abort?.signal.aborted ? " (stopped)" : ""}`);
			if (!this.abort?.signal.aborted && (await this.plugin.countAnswer())) this.showSurvey();
		} catch (err) {
			if (!this.abort?.signal.aborted) {
				const message = (err as Error).message ?? String(err);
				log.error(`Chat turn failed: ${message}`);
				const errEl = this.messagesEl.createDiv({ cls: "lva-msg lva-error", attr: { role: "alert" } });
				errEl.createDiv({ cls: "lva-bubble", text: message });
				const report = errEl.createEl("button", { cls: "lva-chip", text: t("view.report") });
				report.addEventListener("click", () => this.plugin.reportProblem(message));
			}
			this.offerPartialUndo(made);
		} finally {
			window.clearInterval(ticker);
			if (this.abort?.signal.aborted) {
				this.offerPartialUndo(made);
				this.messagesEl.createDiv({ cls: "lva-msg lva-note", text: t("view.stopped") });
			}
			this.abort = null;
			this.setSendState(false);
			this.plugin.agentBusy = false;
			this.plugin.saveChat(this.conversation.messages, this.conversation.id);
			void this.plugin.checkPlacementOnce();
			this.updateStatus();
			this.scrollToBottom();
		}
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
		this.scrollToBottom();
	}

	private async addAssistant(markdown: string): Promise<void> {
		this.messagesEl.querySelector(".lva-welcome")?.remove();
		const root = this.messagesEl.createDiv({ cls: "lva-msg lva-assistant" });
		await this.renderMarkdown(markdown, root.createDiv({ cls: "lva-bubble lva-markdown" }));
		this.scrollToBottom();
	}

	private remember(userText: string, markdown: string): void {
		this.conversation.messages.push({ role: "user", content: userText }, { role: "assistant", content: markdown });
		this.plugin.saveChat(this.conversation.messages, this.conversation.id);
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
		const req = parseQuizRequest(text, new Date()) ?? { topic: text };
		this.addUser(text);
		this.quizBusy = true;
		this.setSendState(true);
		this.updateStatus("Writing quiz questions…");
		const started = Date.now();
		try {
			const lc = this.plugin.lectureCompanion();
			let paths = selectQuizNotes(this.plugin.vault.listNotes(), req, lc?.lectures() ?? []);
			if (paths.length === 0 && req.topic) {
				const hits = await this.plugin.hybridSearch(req.topic, 10);
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
			const questions = await this.plugin.quiz.questions(req.topic, Array.from(this.quizSources, ([path, content]) => ({ path, content })), count, this.abort?.signal);
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
			const message = (err as Error).message ?? String(err);
			this.messagesEl.createDiv({ cls: "lva-msg lva-error" }).createDiv({ cls: "lva-bubble", text: message });
		} finally {
			this.quizBusy = false;
			this.setSendState(false);
			this.updateStatus();
		}
	}

	/** Grades one answer against its source, shows the verdict with the citation, then the next question or the end. */
	private async answerQuiz(text: string): Promise<void> {
		const quiz = this.quiz;
		const q = quiz?.current();
		if (!quiz || !q) return;
		this.addUser(text);
		if (/^(stop|quit|end( the)? quiz|cancel|done)[.!]*$/i.test(text.trim())) {
			await this.finishQuiz(text, "");
			return;
		}
		this.quizBusy = true;
		this.setSendState(true);
		this.updateStatus("Grading…");
		try {
			const source = this.quizSources.get(q.source) ?? "";
			const grade = isNonAnswer(text) ? { verdict: "wrong" as const, feedback: "Skipped." } : await this.plugin.quiz.grade(q, text, source.slice(0, 6000));
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
			new Notice(`Grading failed: ${(err as Error).message}`, 8000);
		} finally {
			this.quizBusy = false;
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
			const copy = actions.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": t("view.copy") } });
			setIcon(copy, "copy");
			copy.addEventListener("click", () => {
				void navigator.clipboard.writeText(this.content);
				new Notice("Copied.");
			});
			const insert = actions.createEl("button", { cls: "clickable-icon lva-icon-btn", attr: { "aria-label": t("view.insert") } });
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
		const btn = summary.createEl("button", { cls: "lva-undo-btn", text: t("view.undo"), attr: { "aria-label": `${t("view.undo")}: ${change.path}` } });
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.plugin.revert(change).then((done) => {
				if (done) {
					btn.disabled = true;
					btn.setText(t("view.undone"));
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
			// "3 notes, best first…"; chats saved by earlier versions hold a JSON list instead.
			const m = /^(\d+) note/.exec(result);
			const n = m ? Number(m[1]) : (result.match(/"path":/g) ?? []).length;
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
