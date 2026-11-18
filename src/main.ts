import { FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, TFile, WorkspaceLeaf, apiVersion, loadPdfJs, moment, normalizePath, requestUrl } from "obsidian";
import { Agent, type AgentConfig } from "./agent";
import { ApprovalModal } from "./approval-modal";
import { LEGACY_SUGGESTIONS_NOTE, gardenFixes, gardenVault, planGardenAction, renderGardenChat, renderPlanResult, type GardenAction, type GardenReport, type PlannedChange } from "./gardener";
import { GistCache, type GistData, type GistStatus } from "./gists";
import { SemanticIndex, weakMatchThreshold, type IndexData, type IndexManifest, type IndexStatus, type StoredFile } from "./index";
import { ObsidianVault } from "./obsidian-vault";
import { OllamaClient, placementWarning, sameModel } from "./ollama";
import { InstructionModal, ProcessDailyModal } from "./prompt-modals";
import { applyConceptLinks, conceptNames, isConceptNote, suggestConcepts } from "./concepts";
import { ConceptModal, HistoryModal, QuizModal } from "./feature-modals";
import { cosine } from "./index";
import { LECTURE_TOOLS, lectureCompanionApi, type LectureCompanionApi, type LocalVaultAgentApi } from "./lecture-companion";
import { QuizEngine } from "./quiz";
import { JOB_NAMES, OverlayVault, PendingQueue, digestPath, digestPrompt, dueJobs, localDate, planPending, recentNotes, renderDigest, type JobId } from "./scheduler";
import { ImageReader, readImage, type VisionData } from "./vision";
import { ReportModal, SetupModal } from "./help-modals";
import { setLocale, t } from "./i18n";
import { log } from "./log";
import { buildReport, chatTranscript, reportTitle, surveyUrl, type ReportInfo } from "./report";
import { SAMPLE_FOLDER, sampleNotes } from "./sample";
import { evaluateSetup, guessTier, type MachineTier } from "./setup";
import { editSelectionPrompt, processDailyNotesPrompt, reformatPrompt, summarizePrompt } from "./prompts";
import { frontmatterText, fuseRankings, keywordSearch } from "./search";
import { DEFAULT_SETTINGS, SAMPLING, isExcluded, migrateSettings, type LocalVaultAgentSettings } from "./settings";
import { LocalVaultAgentSettingTab } from "./settings-tab";
import { ALL_TOOLS } from "./tools";
import type { ApprovalRequest, ChangeRecord, ChatMessage, NoteInfo, SearchHit } from "./types";
import { RevertError, UndoStack, describeChange, planRevert } from "./undo";
import { AgentView, VIEW_TYPE } from "./view";

export default class LocalVaultAgentPlugin extends Plugin {
	settings: LocalVaultAgentSettings = { ...DEFAULT_SETTINGS };
	client!: OllamaClient;
	vault!: ObsidianVault;
	index!: SemanticIndex;
	gists!: GistCache;
	agent!: Agent;
	/** True while a chat turn is running; background gist generation pauses. */
	agentBusy = false;
	/** Every approved write, newest last; saved to history.json, so it survives "New chat" and restarts. */
	readonly undo = new UndoStack();
	/** Changes scheduled jobs produced, waiting for the user's approval (pending.json). */
	readonly pending = new PendingQueue();
	vision!: ImageReader;
	quiz!: QuizEngine;
	/** True when a vision model can read images (read_image is offered to the model). */
	visionAvailable = false;
	/** This plugin's public API (see the README): other plugins open the chat about a note and share the Ollama settings. */
	api!: LocalVaultAgentApi;
	private statusBar: HTMLElement | null = null;
	/** Last time the user typed or clicked in Obsidian (ms), to know they are present. */
	private lastActivity = Date.now();
	private jobRunning = false;
	private pendingNotified = 0;
	private statusListeners = new Set<(s: IndexStatus) => void>();
	private gistListeners = new Set<(s: GistStatus) => void>();

	async onload(): Promise<void> {
		await this.loadSettings();
		setLocale((moment as unknown as { locale(): string }).locale());
		log.info(`Local Vault Agent ${this.manifest.version} loaded (Obsidian ${apiVersion}, ${this.settings.provider})`);

		this.client = new OllamaClient(
			() => (this.settings.provider === "openai" ? this.settings.openaiUrl : this.settings.ollamaUrl),
			// Streaming chat uses the client's own `fetch`; every other request goes through `requestUrl`.
			undefined,
			async (url, body) => {
				// CORS-free fallback through Obsidian's request layer (no streaming).
				const res = await requestUrl({
					url,
					method: "POST",
					body: body || undefined,
					contentType: "application/json",
					throw: false,
				});
				return { status: res.status, text: res.text };
			},
			async (url, method, body, headers) => {
				const res = await requestUrl({ url, method, body, headers, contentType: body ? "application/json" : undefined, throw: false });
				return { status: res.status, text: res.text };
			},
			// The key belongs to the OpenAI-compatible server only: an Ollama server never gets it.
			() => ({ kind: this.settings.provider, apiKey: this.settings.provider === "openai" ? this.settings.openaiKey : undefined }),
		);
		this.vault = new ObsidianVault(this.app, (p) => isExcluded(p, this.settings.excludedFolders));

		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		const indexPath = `${pluginDir}/index.json`;
		const shardDir = `${pluginDir}/index-shards`;
		this.index = new SemanticIndex(
			this.client,
			this.vault,
			{
				load: async () => {
					if (!(await this.app.vault.adapter.exists(indexPath))) return null;
					return JSON.parse(await this.app.vault.adapter.read(indexPath)) as IndexData | IndexManifest;
				},
				save: async (data) => {
					await this.app.vault.adapter.write(indexPath, JSON.stringify(data));
				},
				// The index lives in index-shards/NN.json plus the manifest in index.json: an edited note
				// rewrites one shard, and no single file has to hold every vector of a large vault.
				loadShard: async (i) => {
					const p = `${shardDir}/${String(i).padStart(2, "0")}.json`;
					if (!(await this.app.vault.adapter.exists(p))) return null;
					return JSON.parse(await this.app.vault.adapter.read(p)) as Record<string, StoredFile>;
				},
				saveShard: async (i, files) => {
					if (!(await this.app.vault.adapter.exists(shardDir))) await this.app.vault.adapter.mkdir(shardDir);
					await this.app.vault.adapter.write(`${shardDir}/${String(i).padStart(2, "0")}.json`, JSON.stringify(files));
				},
				saveManifest: async (m) => {
					await this.app.vault.adapter.write(indexPath, JSON.stringify(m));
				},
			},
			{
				getModel: () => this.settings.embeddingModel,
				isEnabled: () => this.settings.semanticSearch,
				shouldIndex: (p) => p.endsWith(".md") && !isExcluded(p, this.settings.excludedFolders),
				onStatus: (s) => this.statusListeners.forEach((l) => l(s)),
			},
		);

		this.chatPath = `${pluginDir}/chat.json`;
		const gistPath = `${pluginDir}/gists.json`;
		this.gists = new GistCache(
			this.client,
			this.vault,
			{
				load: async () => {
					if (!(await this.app.vault.adapter.exists(gistPath))) return null;
					return JSON.parse(await this.app.vault.adapter.read(gistPath)) as GistData;
				},
				save: async (data) => {
					await this.app.vault.adapter.write(gistPath, JSON.stringify(data));
				},
			},
			{
				getModel: () => this.settings.model,
				isEnabled: () => this.settings.gists,
				shouldIndex: (p) => p.endsWith(".md") && !isExcluded(p, this.settings.excludedFolders),
				isBusy: () => this.agentBusy,
				keepAlive: this.settings.keepAlive,
				onStatus: (s) => this.gistListeners.forEach((l) => l(s)),
			},
		);

		const historyPath = `${pluginDir}/history.json`;
		const pendingPath = `${pluginDir}/pending.json`;
		const visionPath = `${pluginDir}/image-cache.json`;
		const readJson = async (path: string): Promise<unknown> => {
			try {
				if (!(await this.app.vault.adapter.exists(path))) return null;
				return JSON.parse(await this.app.vault.adapter.read(path)) as unknown;
			} catch {
				return null;
			}
		};
		this.undo.load(await readJson(historyPath));
		this.pending.load(await readJson(pendingPath));
		let historyTimer: number | null = null;
		this.register(
			this.undo.onChange(() => {
				if (historyTimer !== null) window.clearTimeout(historyTimer);
				historyTimer = window.setTimeout(() => {
					historyTimer = null;
					void this.app.vault.adapter.write(historyPath, JSON.stringify(this.undo.toJSON()));
				}, 1000);
			}),
		);
		this.register(
			this.pending.onChange(() => {
				void this.app.vault.adapter.write(pendingPath, JSON.stringify(this.pending.toJSON()));
				this.updateStatusBar();
			}),
		);

		this.vision = new ImageReader({
			client: this.client,
			getVisionModel: () => this.settings.visionModel,
			getChatModel: () => this.settings.model,
			keepAlive: () => this.settings.keepAlive,
			readBinary: async (path) => {
				const file = this.app.vault.getFileByPath(normalizePath(path));
				if (!file) throw new Error(`File not found: ${path}`);
				return this.app.vault.readBinary(file);
			},
			renderPdfPage: (path, page) => this.renderPdfPage(path, page),
			load: async () => (await readJson(visionPath)) as VisionData | null,
			save: async (data) => {
				await this.app.vault.adapter.write(visionPath, JSON.stringify(data));
			},
		});
		this.quiz = new QuizEngine(this.client, () => ({ model: this.settings.model, numCtx: this.settings.numCtx, keepAlive: this.settings.keepAlive }));

		this.agent = new Agent({
			client: this.client,
			vault: this.vault,
			tools: ALL_TOOLS,
			search: (q, limit) => this.hybridSearch(q, limit),
			searchPassages: async (q, limit) => {
				if (!this.index.ready) return [];
				try {
					return await this.index.searchPassages(q, limit);
				} catch {
					return [];
				}
			},
			weakMatchBelow: () => weakMatchThreshold(this.settings.embeddingModel),
			approve: (req) => {
				const modal = new ApprovalModal(this.app, req);
				modal.open();
				return modal.result;
			},
			getConfig: () => this.agentConfig(),
			configDir: this.app.vault.configDir,
			undo: this.undo,
			gist: (path) => (this.settings.gists ? this.gists.get(path) : undefined),
			readAttachmentText: (path) => this.readAttachmentText(path),
			extraTools: () => this.extraTools(),
			lectures: () => this.lectureCompanion() ?? undefined,
			describeImage: () => (this.visionAvailable ? (path, opts) => this.vision.describe(path, opts) : undefined),
			dailyNote: async () => {
				await this.loadDailyNoteSettings();
				return this.dailyNote();
			},
			readConventions: async () => {
				const path = this.vault.resolve(this.settings.conventionsNote);
				return path ? this.vault.read(path) : null;
			},
		});

		this.registerView(VIEW_TYPE, (leaf) => new AgentView(leaf, this));
		this.addRibbonIcon("bot", t("ribbon.open"), () => void this.activateView());
		this.addSettingTab(new LocalVaultAgentSettingTab(this.app, this));

		this.addCommand({
			id: "open-chat",
			name: t("cmd.openChat"),
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: "ask-about-selection",
			name: t("cmd.askSelection"),
			editorCallback: async (editor) => {
				const sel = editor.getSelection();
				const view = await this.activateView();
				view?.prefill(sel ? `About this selected text:\n"""\n${sel}\n"""\n\n` : "");
			},
		});
		this.addCommand({
			id: "reformat-current-note",
			name: t("cmd.reformat"),
			checkCallback: (checking) => {
				if (!this.activeNote()) return false;
				if (!checking) void this.reformatCurrentNote();
				return true;
			},
		});
		this.addCommand({
			id: "summarize-current-note",
			name: t("cmd.summarize"),
			checkCallback: (checking) => {
				if (!this.activeNote()) return false;
				if (!checking) void this.summarizeCurrentNote();
				return true;
			},
		});
		this.addCommand({
			id: "edit-selection",
			name: t("cmd.editSelection"),
			editorCheckCallback: (checking, editor) => {
				if (!editor.getSelection().trim()) return false;
				if (!checking) void this.editSelection();
				return true;
			},
		});
		this.addCommand({
			id: "process-daily-notes",
			name: t("cmd.daily"),
			callback: () => void this.processDailyNotes(),
		});
		this.addCommand({
			id: "suggest-improvements",
			name: t("cmd.garden"),
			callback: () => void this.suggestImprovements(),
		});
		this.addCommand({
			id: "undo-last-change",
			name: t("cmd.undoLast"),
			checkCallback: (checking) => {
				if (!this.undo.latest()) return false;
				if (!checking) void this.undoLast();
				return true;
			},
		});
		this.addCommand({
			id: "undo-last-message",
			name: t("cmd.undoTurn"),
			checkCallback: (checking) => {
				if (!this.undo.latest()) return false;
				if (!checking) void this.undoLastTurn();
				return true;
			},
		});
		this.addCommand({
			id: "report-problem",
			name: t("cmd.report"),
			callback: () => this.reportProblem(),
		});
		this.addCommand({
			id: "setup-checklist",
			name: t("cmd.setup"),
			callback: () => this.openSetup(),
		});
		this.addCommand({
			id: "try-sample",
			name: t("cmd.sample"),
			callback: () => void this.trySample(),
		});
		this.addCommand({
			id: "change-history",
			name: t("cmd.history"),
			callback: () => this.showHistory(),
		});
		this.addCommand({
			id: "quiz-me",
			name: t("cmd.quiz"),
			callback: () => void this.startQuiz(),
		});
		this.addCommand({
			id: "suggest-concept-links",
			name: t("cmd.concepts"),
			checkCallback: (checking) => {
				if (!this.activeNote()) return false;
				if (!checking) void this.suggestConceptLinks();
				return true;
			},
		});
		this.addCommand({
			id: "review-scheduled-changes",
			name: t("cmd.review"),
			checkCallback: (checking) => {
				if (this.pending.size === 0) return false;
				if (!checking) void this.reviewPending();
				return true;
			},
		});
		this.addCommand({
			id: "run-nightly-job",
			name: t("cmd.runNightly"),
			callback: () => void this.runJob("daily", true),
		});
		this.addCommand({
			id: "run-digest-job",
			name: t("cmd.runDigest"),
			callback: () => void this.runJob("digest", true),
		});
		this.addCommand({
			id: "rebuild-gists",
			name: t("cmd.gists"),
			callback: async () => {
				new Notice("Regenerating gists for every note in the background…");
				await this.gists.syncAll(true);
				const s = this.gists.status();
				new Notice(s.lastError ? `Gist error: ${s.lastError}` : `Gists ready for ${s.done} notes.`);
			},
		});
		this.addCommand({
			id: "rebuild-index",
			name: t("cmd.index"),
			callback: async () => {
				new Notice("Rebuilding the semantic index…");
				await this.index.syncAll(true);
				const s = this.index.status();
				new Notice(s.lastError ? `Index error: ${s.lastError}` : `Indexed ${s.indexedFiles} notes.`);
			},
		});

		// Keep the index in step with the vault. Debounce per path so a burst of edits to one
		// note embeds once, while edits to different notes are all picked up. Ten seconds rather
		// than two: a note being typed in pauses every few seconds, and each pause woke the GPU.
		const timers = new Map<string, number>();
		const changed = (file: TFile) => {
			const existing = timers.get(file.path);
			if (existing !== undefined) window.clearTimeout(existing);
			timers.set(
				file.path,
				window.setTimeout(() => {
					timers.delete(file.path);
					this.index.enqueue(file.path);
					this.gists.enqueue(file.path);
				}, 10000),
			);
		};
		this.register(() => timers.forEach((t) => window.clearTimeout(t)));
		this.registerEvent(this.app.vault.on("modify", (f) => f instanceof TFile && f.extension === "md" && changed(f)));
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (!(f instanceof TFile)) return;
				this.index.remove(f.path);
				this.gists.remove(f.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, old) => {
				if (!(f instanceof TFile)) return;
				this.index.rename(old, f.path);
				this.gists.rename(old, f.path);
			}),
		);

		this.app.workspace.onLayoutReady(async () => {
			// Registered here, not above: while the vault loads Obsidian fires "create" for every existing
			// file, which queued the whole vault again on each launch. Notes added while Obsidian was
			// closed are found by syncAll below.
			this.registerEvent(this.app.vault.on("create", (f) => f instanceof TFile && f.extension === "md" && changed(f)));
			await this.loadDailyNoteSettings();
			void this.checkOllamaOnce();
			await this.index.load();
			await this.gists.load();
			// Embeddings first (fast, small model), then gists (chat model), so they never run together.
			void (async () => {
				if (this.settings.semanticSearch) await this.index.syncAll();
				if (this.settings.gists) await this.gists.syncAll();
			})();
			void this.refreshVision();
			this.updateStatusBar();
			void this.tick();
		});

		this.api = {
			version: 1,
			openChatAbout: (path) => this.openChatAbout(path),
			// `provider` was added in 0.8.0. `url` and `model` stay Ollama's: callers from before 0.8.0 copy them into
			// their Ollama settings without looking at `provider`, so another server's model is not handed out (empty is skipped).
			ollama: () => ({ url: this.settings.ollamaUrl, model: this.settings.provider === "ollama" ? this.settings.model : "", provider: this.settings.provider }),
		};

		// Scheduled jobs: checked every minute while Obsidian is open; the user's presence is a key or click.
		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("lva-pending-badge");
		this.registerDomEvent(this.statusBar, "click", () => void this.reviewPending());
		const seen = () => {
			const away = Date.now() - this.lastActivity > 5 * 60_000;
			this.lastActivity = Date.now();
			if (away) this.notifyPending();
		};
		this.registerDomEvent(activeDocument, "keydown", seen);
		this.registerDomEvent(activeDocument, "pointerdown", seen);
		this.registerInterval(window.setInterval(() => void this.tick(), 60_000));
	}

	onunload(): void {
		this.index.cancel();
		void this.index.flush();
		this.gists.cancel();
		void this.gists.flush();
	}

	private chatPath = "";
	private chatSaveTimer: number | null = null;

	/** The last conversation, so a chat survives closing the panel or restarting Obsidian. */
	async loadChat(): Promise<ChatMessage[] | null> {
		try {
			if (!this.chatPath || !(await this.app.vault.adapter.exists(this.chatPath))) return null;
			const data = JSON.parse(await this.app.vault.adapter.read(this.chatPath)) as { messages?: ChatMessage[]; id?: string };
			if (typeof data.id === "string") this.lastChatId = data.id;
			return Array.isArray(data.messages) ? data.messages : null;
		} catch {
			return null;
		}
	}

	/** The id of the chat restored from chat.json, so its changes stay grouped in the history. */
	lastChatId: string | null = null;

	saveChat(messages: ChatMessage[], id?: string): void {
		if (!this.chatPath) return;
		if (this.chatSaveTimer !== null) window.clearTimeout(this.chatSaveTimer);
		this.chatSaveTimer = window.setTimeout(() => {
			this.chatSaveTimer = null;
			// Thinking is dropped: it is large and never shown again.
			const slim = messages.map((m) => (m.thinking || m.images ? { ...m, thinking: undefined, images: undefined } : m));
			void this.app.vault.adapter.write(this.chatPath, JSON.stringify({ id, messages: slim }));
		}, 500);
	}

	async clearChat(): Promise<void> {
		if (!this.chatPath) return;
		try {
			if (await this.app.vault.adapter.exists(this.chatPath)) await this.app.vault.adapter.remove(this.chatPath);
		} catch {
			// nothing to clear
		}
	}

	private dailyFormat = "YYYY-MM-DD";
	private dailyFolder = "";

	/** Reads the core Daily Notes plugin's folder/format so "today's note" means what the user's does. */
	private async loadDailyNoteSettings(): Promise<void> {
		try {
			const p = `${this.app.vault.configDir}/daily-notes.json`;
			if (!(await this.app.vault.adapter.exists(p))) return;
			const cfg = JSON.parse(await this.app.vault.adapter.read(p)) as { folder?: string; format?: string };
			if (typeof cfg.format === "string" && cfg.format.trim()) this.dailyFormat = cfg.format.trim();
			if (typeof cfg.folder === "string") this.dailyFolder = cfg.folder.replace(/^\/+|\/+$/g, "");
		} catch {
			// keep defaults
		}
	}

	dailyNote(): { path: string; exists: boolean } | null {
		try {
			const now = (moment as unknown as () => { format(f: string): string })();
			const name = now.format(this.dailyFormat);
			const path = normalizePath(`${this.dailyFolder ? this.dailyFolder + "/" : ""}${name}.md`);
			return { path, exists: this.app.vault.getFileByPath(path) !== null };
		} catch {
			return null;
		}
	}

	private ollamaChecked = false;

	/** One Notice per session when Ollama or the chosen model is not available, with the fix. */
	private async checkOllamaOnce(): Promise<void> {
		if (this.ollamaChecked) return;
		this.ollamaChecked = true;
		try {
			const models = await this.client.listModels();
			const missing: string[] = [];
			if (!models.some((m) => sameModel(m.name, this.settings.model))) missing.push(this.settings.model);
			if (this.settings.semanticSearch && !models.some((m) => sameModel(m.name, this.settings.embeddingModel))) missing.push(this.settings.embeddingModel);
			if (missing.length) {
				log.warn(`Models not installed: ${missing.join(", ")}`);
				this.notifyError(`Local Vault Agent: model${missing.length === 1 ? "" : "s"} not installed: ${missing.join(", ")}. Open the setup checklist to download ${missing.length === 1 ? "it" : "them"}, or pick another model in settings.`, { setup: true });
			}
		} catch (err) {
			log.error(`Server unreachable at load: ${(err as Error).message}`);
			this.notifyError(`Local Vault Agent cannot reach ${this.settings.provider === "ollama" ? "Ollama" : "the model server"} at ${this.client.baseUrl} (${(err as Error).message}). Start it or fix the URL in settings.`, { setup: true });
		}
	}

	private placementChecked = false;

	/**
	 * One Notice per session, after a turn, when the chat model is only partly on the GPU: the usual
	 * reason the agent feels slow, and one the user cannot see from inside Obsidian.
	 */
	async checkPlacementOnce(): Promise<void> {
		if (this.placementChecked) return;
		try {
			const warning = placementWarning(await this.client.ps(), this.settings.model);
			if (!warning) return;
			this.placementChecked = true;
			new Notice(`Local Vault Agent: ${warning}`, 15000);
		} catch {
			// Ollama unreachable or an older server without /api/ps: nothing to say.
		}
	}

	/** Text of a PDF (via Obsidian's bundled pdf.js) or a text-like attachment. */
	async readAttachmentText(path: string): Promise<string> {
		const file = this.app.vault.getFileByPath(normalizePath(path));
		if (!file) throw new Error(`File not found: ${path}`);
		const ext = file.extension.toLowerCase();
		if (ext === "pdf") {
			const pdfjs = (await loadPdfJs()) as {
				getDocument(src: { data: ArrayBuffer }): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string }[] }> }> }> };
			};
			const data = await this.app.vault.readBinary(file);
			const doc = await pdfjs.getDocument({ data }).promise;
			const pages: string[] = [];
			for (let i = 1; i <= doc.numPages; i++) {
				const page = await doc.getPage(i);
				const content = await page.getTextContent();
				const text = content.items.map((it) => it.str ?? "").join(" ").replace(/\s+/g, " ").trim();
				pages.push(`--- Page ${i} ---\n${text}`);
			}
			return pages.join("\n\n");
		}
		if (["txt", "csv", "json", "html", "htm", "xml", "yaml", "yml", "log", "tsv", "org", "tex", "srt", "vtt"].includes(ext)) {
			return this.app.vault.read(file);
		}
		throw new Error(`Cannot extract text from .${ext} files.`);
	}

	activeNote(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		return file && file.extension === "md" ? file : null;
	}

	/** Sends the reformat prompt for the open note (command and /reformat). */
	async reformatCurrentNote(view?: AgentView | null): Promise<void> {
		const file = this.activeNote();
		if (!file) {
			new Notice("Open a markdown note first.");
			return;
		}
		const content = await this.app.vault.cachedRead(file);
		const target = view ?? (await this.activateView());
		await target?.send(reformatPrompt(file.path, content));
	}

	/** The markdown editor showing the active note, even when the chat panel has focus. */
	private activeEditorView(): MarkdownView | null {
		const direct = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (direct) return direct;
		const path = this.activeNote()?.path;
		if (!path) return null;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) return view;
		}
		return null;
	}

	/** Asks for an instruction and has the agent rewrite the selected text (command and /edit). */
	async editSelection(view?: AgentView | null): Promise<void> {
		const editorView = this.activeEditorView();
		const selection = editorView?.editor.getSelection() ?? "";
		const file = editorView?.file;
		if (!file || !selection.trim()) {
			new Notice("Select some text in a note first.");
			return;
		}
		const modal = new InstructionModal(this.app, selection);
		modal.open();
		const instruction = await modal.result;
		if (!instruction) return;
		const target = view ?? (await this.activateView());
		await target?.send(editSelectionPrompt(file.path, selection, instruction));
	}

	/** Asks for options and runs the daily-notes distillation (command and /daily). */
	async processDailyNotes(view?: AgentView | null): Promise<void> {
		const s = this.settings;
		const modal = new ProcessDailyModal(this.app, {
			folder: this.dailyFolder,
			heading: s.dailyInboxHeading,
			destination: s.dailyTopicsFolder,
			move: s.dailyMoveItems,
		});
		modal.open();
		const opts = await modal.result;
		if (!opts) return;
		s.dailyInboxHeading = opts.heading;
		s.dailyTopicsFolder = opts.destination;
		s.dailyMoveItems = opts.move;
		await this.saveSettings();
		const target = view ?? (await this.activateView());
		await target?.send(processDailyNotesPrompt(opts));
	}

	/**
	 * The vault gardener: analyses the vault without a model and reports in the chat, with a
	 * button per section. Nothing is written to the vault here.
	 */
	async suggestImprovements(view?: AgentView | null): Promise<void> {
		const target = view ?? (await this.activateView());
		if (!target) return;
		const hasIndex = this.settings.semanticSearch && this.index.ready;
		const conventions = this.settings.conventionsNote.trim() ? this.vault.resolve(this.settings.conventionsNote) : null;
		const report = await gardenVault(this.vault, {
			dailyFolder: this.dailyFolder,
			inboxHeading: this.settings.dailyInboxHeading,
			// The conventions note is read on every message; it needs no links to be in use.
			exclude: (p) => isExcluded(p, this.settings.excludedFolders) || p === conventions,
			noteVectors: hasIndex ? this.index.noteVectors() : undefined,
		});
		await target.showGardenReport(renderGardenChat(report, { hasIndex }), gardenFixes(report), report, this.app.vault.getFileByPath(LEGACY_SUGGESTIONS_NOTE) !== null);
	}

	/**
	 * Carries out one of the gardener's mechanical fixes (repoint moved links, link mentions, remove
	 * identical copies) without the model: the edits are worked out from the notes as they are now,
	 * each is shown as a diff and recorded for undo under `turn`, exactly like an agent edit. Returns
	 * the report for the chat, or null when the action is not a mechanical one.
	 */
	async applyGardenAction(action: GardenAction, report: GardenReport, turn: number, chat?: string): Promise<string | null> {
		const plan = await planGardenAction(this.vault, action, report);
		if (!plan) return null;
		const applied: PlannedChange[] = [];
		let approveAll = this.settings.autoApproveEdits;
		let stopped = false;
		for (const change of plan.changes) {
			if (!approveAll) {
				const modal = new ApprovalModal(this.app, { tool: change.tool, path: change.path, before: change.before, after: change.after, summary: change.summary });
				modal.open();
				const decision = await modal.result;
				if (decision === "reject") {
					stopped = true;
					break;
				}
				if (decision === "approve-all") approveAll = true;
			}
			if (change.tool === "delete_file") await this.vault.trash(change.path);
			else await this.vault.modify(change.path, change.after);
			this.undo.push({ tool: change.tool, path: change.path, before: change.before, after: change.after, time: Date.now(), turn, chat, summary: change.summary });
			applied.push(change);
		}
		return renderPlanResult(applied, plan, stopped);
	}

	/** Moves the checklist note older versions wrote to the trash (its open checkboxes show up in task queries). */
	async deleteLegacySuggestions(): Promise<boolean> {
		const file = this.app.vault.getFileByPath(LEGACY_SUGGESTIONS_NOTE);
		if (!file) return false;
		await this.app.fileManager.trashFile(file);
		return true;
	}

	/** Sends the summarize prompt for the open note (command and /summarize). */
	async summarizeCurrentNote(view?: AgentView | null): Promise<void> {
		const file = this.activeNote();
		if (!file) {
			new Notice("Open a markdown note first.");
			return;
		}
		const target = view ?? (await this.activateView());
		await target?.send(summarizePrompt(file.path));
	}

	async undoLast(): Promise<void> {
		const latest = this.undo.latest();
		if (!latest) {
			new Notice("Nothing to undo.");
			return;
		}
		await this.revert(latest);
	}

	async undoLastTurn(): Promise<void> {
		const latest = this.undo.latest();
		if (!latest) {
			new Notice("Nothing to undo.");
			return;
		}
		await this.revertTurn(latest.turn, latest.chat);
	}

	/**
	 * Undo one recorded change. The restore is shown as a diff (current → restored) and only
	 * applied when approved, exactly like the change itself was. A note edited since is restored
	 * only where the change was, keeping the later edits; when they overlap it, the undo is refused.
	 * The undo is itself recorded, so it can be undone in turn.
	 */
	async revert(change: ChangeRecord): Promise<boolean> {
		let plan;
		try {
			plan = await planRevert(change, this.vault);
		} catch (err) {
			new Notice((err as Error).message, 8000);
			if (err instanceof RevertError && err.kind === "nothing") this.undo.markUndone(change.id);
			return false;
		}
		const modal = new ApprovalModal(this.app, plan);
		modal.open();
		const decision = await modal.result;
		if (decision === "reject") return false;
		try {
			await plan.apply();
		} catch (err) {
			log.error(`Undo failed for ${change.path}: ${(err as Error).message}`);
			this.notifyError(`Undo failed: ${(err as Error).message}`);
			return false;
		}
		this.undo.markUndone(change.id);
		const base = { time: Date.now(), turn: change.turn, chat: change.chat, summary: plan.summary };
		if (change.tool === "create_note") this.undo.push({ ...base, tool: "delete_file", path: change.path, before: plan.before, after: "" });
		else if (change.tool === "delete_file") {
			if (/\.md$/i.test(change.path)) this.undo.push({ ...base, tool: "create_note", path: change.path, before: "", after: change.before });
		} else if (change.tool === "move_note") this.undo.push({ ...base, tool: "move_note", path: change.before, before: change.after, after: change.before });
		else this.undo.push({ ...base, tool: "undo", path: change.path, before: plan.before, after: plan.after });
		log.info(`Undone: ${describeChange(change)}`);
		new Notice(`Undone: ${describeChange(change)}.`);
		return true;
	}

	/** Undo every change of one agent turn, newest first, stopping at the first rejection. */
	async revertTurn(turn: number, chat?: string): Promise<void> {
		const changes = this.undo.forTurn(turn, chat);
		if (changes.length === 0) {
			new Notice("Nothing to undo.");
			return;
		}
		let done = 0;
		for (const change of changes) {
			if (!(await this.revert(change))) break;
			done++;
		}
		if (changes.length > 1) new Notice(`Undid ${done} of ${changes.length} changes.`);
	}

	/** Records an error in the log the problem report shows. */
	logError(message: string): void {
		log.error(message);
	}

	/** A notice for something that went wrong, with a "Report" link (and "Setup checklist" when that is the likely fix). */
	notifyError(message: string, opts: { setup?: boolean } = {}): void {
		const frag = createFragment();
		frag.createSpan({ text: `${message} ` });
		if (opts.setup) {
			const setup = frag.createEl("a", { text: t("cmd.setup"), href: "#" });
			setup.addEventListener("click", (e) => {
				e.preventDefault();
				this.openSetup();
			});
			frag.createSpan({ text: " · " });
		}
		const report = frag.createEl("a", { text: t("view.report"), href: "#" });
		report.addEventListener("click", (e) => {
			e.preventDefault();
			this.reportProblem(message);
		});
		new Notice(frag, 15000);
	}

	/** Absolute vault folder and home folder, so the report can replace them by <vault> and ~. */
	private reportPaths(): { vault?: string; home?: string } {
		const adapter = this.app.vault.adapter;
		const vault = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
		// The real home folder on desktop (the vault may be on another drive, and the name may hold a space,
		// which the report's general C:\Users\name pattern stops at); guessed from the vault path otherwise.
		let home: string | undefined;
		if (Platform.isDesktopApp) {
			// The environment holds the home folder on every desktop platform; no Node module is needed
			// (there is no Node on mobile, where this stays undefined and the guess below is used).
			const env = (window as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
			home = env?.USERPROFILE || env?.HOME || undefined;
		}
		home ??= vault ? /^(?:[A-Za-z]:[\\/]Users[\\/][^\\/]+|\/(?:Users|home)\/[^/]+)/.exec(vault)?.[0] : undefined;
		return { vault, home };
	}

	/** Everything the report needs that is not secret, collected live (the model list only when the server answers). */
	private async reportInfo(): Promise<ReportInfo> {
		const s = this.settings;
		let serverVersion: string | null = null;
		let installed: string[] | null = null;
		try {
			serverVersion = await this.client.version();
			installed = (await this.client.listModels()).map((m) => m.name);
		} catch (err) {
			log.warn(`Report: server not reachable (${(err as Error).message})`);
		}
		const idx = this.index.status();
		const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins?.enabledPlugins;
		return {
			pluginVersion: this.manifest.version,
			obsidianVersion: apiVersion,
			platform: Platform.isWin ? "Windows" : Platform.isMacOS ? "macOS" : Platform.isLinux ? "Linux" : Platform.isAndroidApp ? "Android" : Platform.isIosApp ? "iOS" : "unknown",
			mobile: Platform.isMobile,
			provider: s.provider === "ollama" ? "Ollama" : "OpenAI-compatible",
			serverVersion,
			chatModel: s.model,
			embeddingModel: s.embeddingModel,
			visionModel: s.visionModel,
			installedModels: installed,
			notes: this.vault.listNotes().length,
			index: !s.semanticSearch ? "semantic search off" : idx.building ? `building (${idx.indexedFiles} done, ${idx.pending} pending)` : idx.lastError ? `error: ${idx.lastError}` : `${idx.indexedFiles} notes, ${idx.totalChunks} chunks`,
			otherPlugins: plugins ? Array.from(plugins).filter((id) => id !== this.manifest.id).sort() : [],
			settings: { ...s } as unknown as Record<string, unknown>,
			log: log.tail(50),
		};
	}

	/** Opens the "Report a problem" dialog; `description` pre-fills what happened (e.g. the error message). */
	reportProblem(description = ""): void {
		void (async () => {
			const info = await this.reportInfo();
			const paths = this.reportPaths();
			const chat = (await this.loadChat()) ?? [];
			new ReportModal(this.app, (desc, includeChat) => buildReport(info, desc, { paths, chat: includeChat ? chatTranscript(chat) : undefined }), (desc) => reportTitle(desc, log.lastError()?.message, paths), description).open();
		})();
	}

	/** The setup checklist: server, models, index, each with a fix. */
	openSetup(): void {
		const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
		new SetupModal(this.app, {
			initialTier: guessTier(deviceMemory),
			evaluate: async (tier: MachineTier) => {
				let models = null;
				let serverError: string | undefined;
				try {
					models = await this.client.listModels();
				} catch (err) {
					serverError = (err as Error).message;
					log.warn(`Setup: ${serverError}`);
				}
				return evaluateSetup({ provider: this.settings.provider, models, serverError, chatModel: this.settings.model, embeddingModel: this.settings.embeddingModel, semanticSearch: this.settings.semanticSearch, index: this.index.status(), notes: this.vault.listNotes().length, tier });
			},
			pull: async (model, onProgress) => {
				log.info(`Pulling ${model}`);
				await this.client.pull(model, onProgress);
				log.info(`Pulled ${model}`);
			},
			use: async (model, role) => {
				if (role === "chat") this.settings.model = model;
				else this.settings.embeddingModel = model;
				await this.saveSettings();
				void this.refreshVision();
				if (role === "embed" && this.settings.semanticSearch) void this.index.syncAll();
			},
			buildIndex: async () => {
				await this.index.syncAll();
			},
			openSettings: () => {
				const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
				setting?.open();
				setting?.openTabById(this.manifest.id);
			},
			trySample: () => this.trySample(),
		}).open();
	}

	/**
	 * Creates the sample notes (once) and opens the chat with three questions to try. The notes are
	 * the user's own request, so they are written without a diff, and recorded in the change history.
	 */
	async trySample(): Promise<void> {
		const notes = sampleNotes(SAMPLE_FOLDER);
		let created = 0;
		for (const n of notes) {
			if (this.vault.exists(n.path)) continue;
			const folder = n.path.slice(0, n.path.lastIndexOf("/"));
			if (!this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
			await this.vault.create(n.path, n.content);
			this.undo.push({ tool: "create_note", path: n.path, before: "", after: n.content, time: Date.now(), turn: 0, chat: "plugin", summary: `Sample note ${n.path}` });
			this.index.enqueue(n.path);
			created++;
		}
		new Notice(created ? t("notice.sampleCreated", { n: created, folder: SAMPLE_FOLDER }) : t("notice.sampleExists", { folder: SAMPLE_FOLDER }));
		log.info(`Sample notes: ${created} created`);
		const view = await this.activateView();
		view?.showSampleQuestions();
	}

	/** Called after each answered message: shows the one-question survey once, after the fifth answer. */
	async countAnswer(): Promise<boolean> {
		if (this.settings.survey !== "ask") return false;
		this.settings.answeredTurns++;
		// Marked as asked when it is shown (and before the save, so two chats finishing together show one card):
		// an ignored card is not followed by another after every later answer.
		const ask = this.settings.answeredTurns >= 5;
		if (ask) this.settings.survey = "done";
		await this.saveSettings();
		return ask;
	}

	/** The survey was answered or dismissed: never asked again. `answer` opens a prefilled discussion. */
	async finishSurvey(answer: string | null): Promise<void> {
		this.settings.survey = "done";
		await this.saveSettings();
		if (answer) window.open(surveyUrl(answer, this.manifest.version));
	}

	/** Lecture Companion's API (version 1), or null when it is not installed or enabled. */
	lectureCompanion(): LectureCompanionApi | null {
		return lectureCompanionApi(this.app);
	}

	/** Tools that depend on other plugins and models: Lecture Companion's lectures, the vision model. */
	extraTools() {
		return [...(this.lectureCompanion() ? LECTURE_TOOLS : []), ...(this.visionAvailable ? [readImage] : [])];
	}

	/** Re-checks whether a vision model is available (after settings change and on load). */
	async refreshVision(): Promise<void> {
		this.vision.reset();
		this.visionAvailable = (await this.vision.model()) !== null;
	}

	/** Copies Lecture Companion's Ollama URL and model into these settings. */
	async useLectureCompanionOllama(): Promise<boolean> {
		const lc = this.lectureCompanion();
		if (!lc) return false;
		const { url, model } = lc.ollama();
		if (url) this.settings.ollamaUrl = url;
		if (model) this.settings.model = model;
		await this.saveSettings();
		return true;
	}

	/** The public API's openChatAbout: the chat with the note attached and a prompt to ask about it. */
	async openChatAbout(path: string): Promise<void> {
		const resolved = this.vault.resolve(path);
		if (!resolved) {
			new Notice(`Local Vault Agent: no note ${path}.`);
			return;
		}
		const view = await this.activateView();
		view?.prefill(`About [[${resolved.replace(/\.md$/i, "")}]]: `);
	}

	/** Shows the diff, writes on approval, records the change. Returns whether it was written. */
	async writeWithApproval(req: ApprovalRequest, chat = "plugin", turn = 0): Promise<boolean> {
		if (!this.settings.autoApproveEdits) {
			const modal = new ApprovalModal(this.app, req);
			modal.open();
			if ((await modal.result) === "reject") return false;
		}
		const existed = this.vault.exists(req.path);
		if (existed) {
			if ((await this.vault.read(req.path)) !== req.before) {
				new Notice(`${req.path} changed while the diff was open; nothing written.`, 8000);
				return false;
			}
			await this.vault.modify(req.path, req.after);
		} else {
			const folder = req.path.includes("/") ? req.path.slice(0, req.path.lastIndexOf("/")) : "";
			if (folder && !this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
			await this.vault.create(req.path, req.after);
		}
		this.undo.push({ tool: existed ? req.tool : "create_note", path: req.path, before: existed ? req.before : "", after: req.after, time: Date.now(), turn, chat, summary: req.summary });
		return true;
	}

	showHistory(): void {
		new HistoryModal(
			this.app,
			() => this.undo.list(),
			(c) => this.revert(c),
			(path) => void this.app.workspace.openLinkText(path, "", false),
			(l) => this.undo.onChange(l),
		).open();
	}

	/** "Quiz me": asks for the topic and starts the quiz in the chat. */
	async startQuiz(view?: AgentView | null): Promise<void> {
		const lc = this.lectureCompanion();
		const modal = new QuizModal(this.app, lc?.courses() ?? [], this.settings.quizQuestions);
		modal.open();
		const opts = await modal.result;
		if (!opts) return;
		const target = view ?? (await this.activateView());
		const text = `Quiz me${opts.topic ? ` on ${opts.topic}` : ""}${opts.since ? ` since ${opts.since}` : ""}`;
		await target?.startQuiz(text, opts.count);
	}

	/** "Suggest concept links for this note": concept notes it mentions or is close to, as one diff. */
	async suggestConceptLinks(): Promise<void> {
		const file = this.activeNote();
		if (!file) {
			new Notice("Open a note first.");
			return;
		}
		const content = await this.app.vault.read(file);
		const folders = this.settings.conceptFolders;
		const concepts = this.vault
			.listNotes()
			.filter((n) => n.path !== file.path)
			.map((n) => ({ n, meta: this.vault.getMetadata(n.path) }))
			.filter(({ n, meta }) => isConceptNote(n, folders, meta))
			.map(({ n, meta }) => ({ note: n, names: conceptNames(n, meta.frontmatter.aliases) }));
		if (concepts.length === 0) {
			new Notice(`No concept notes found. Put them in ${folders.join(" or ") || "a concept folder"} (Settings → Concept folders), or tag them #concept.`, 10000);
			return;
		}
		let related: { path: string; score: number }[] = [];
		if (this.settings.semanticSearch && this.index.ready) {
			const vectors = this.index.noteVectors();
			const mine = vectors.get(file.path);
			if (mine) {
				const conceptPaths = new Set(concepts.map((c) => c.note.path));
				related = Array.from(vectors)
					.filter(([p]) => conceptPaths.has(p))
					.map(([p, v]) => ({ path: p, score: cosine(mine, v) }))
					.filter((r) => r.score >= 0.6);
			}
		}
		const suggestions = suggestConcepts({ path: file.path, content }, concepts, related);
		if (suggestions.length === 0) {
			new Notice(`${file.basename} mentions none of your ${concepts.length} concept notes that it does not already link.`, 8000);
			return;
		}
		const modal = new ConceptModal(this.app, file.path, suggestions);
		modal.open();
		const picked = await modal.result;
		if (!picked) return;
		const current = await this.app.vault.read(file);
		const after = applyConceptLinks(current, picked.chosen, picked.property);
		if (after === current) {
			new Notice("Nothing to change.");
			return;
		}
		const n = picked.chosen.length;
		const ok = await this.writeWithApproval({ tool: "edit_note", path: file.path, before: current, after, summary: `Link ${n} concept${n === 1 ? "" : "s"} in ${file.basename}` });
		if (ok) new Notice(`Linked ${n} concept${n === 1 ? "" : "s"}.`);
	}

	/** Runs due scheduled jobs (at most one at a time) and reminds a present user of waiting changes. */
	private async tick(): Promise<void> {
		if (!this.jobRunning && !this.agentBusy) {
			const due = dueJobs(new Date(), this.settings, this.settings.jobRuns);
			for (const job of due) await this.runJob(job, false);
		}
		this.notifyPending();
	}

	/**
	 * Runs one scheduled job against an overlay of the vault: whatever it would write is queued for
	 * review, nothing is written. `manual` when the user ran it from the command palette.
	 */
	async runJob(job: JobId, manual: boolean): Promise<void> {
		if (this.jobRunning) {
			if (manual) new Notice("A scheduled job is already running.");
			return;
		}
		this.jobRunning = true;
		this.settings.jobRuns[job] = Date.now();
		await this.saveSettings();
		if (manual) new Notice(`${JOB_NAMES[job]}: running in the background; the changes will wait for your review.`);
		try {
			const changes = job === "daily" ? await this.runDailyJob() : await this.runDigestJob();
			const added = this.pending.add(job, changes);
			if (added.length) {
				this.pendingNotified = 0;
				this.notifyPending(manual);
			} else if (manual) new Notice(`${JOB_NAMES[job]}: nothing to change.`);
		} catch (err) {
			log.error(`${JOB_NAMES[job]} failed: ${(err as Error).message}`);
			this.notifyError(`${JOB_NAMES[job]} failed: ${(err as Error).message}`);
		} finally {
			this.jobRunning = false;
		}
	}

	private async runDailyJob() {
		await this.loadDailyNoteSettings();
		const overlay = new OverlayVault(this.vault);
		const since = localDate(new Date(Date.now() - 2 * 86_400_000));
		const agent = new Agent({
			client: this.client,
			vault: overlay,
			tools: ALL_TOOLS.filter((t) => t.name !== "move_note" && t.name !== "delete_file"),
			search: (q, limit) => this.hybridSearch(q, limit),
			approve: async () => "approve",
			getConfig: () => ({ ...this.agentConfig(), autoApprove: true, autoContinue: true, citations: "off" }),
			configDir: this.app.vault.configDir,
			readConventions: async () => {
				const path = this.vault.resolve(this.settings.conventionsNote);
				return path ? this.vault.read(path) : null;
			},
		});
		const s = this.settings;
		const prompt = processDailyNotesPrompt({ folder: this.dailyFolder, heading: s.dailyInboxHeading, destination: s.dailyTopicsFolder, move: s.dailyMoveItems, since });
		this.agentBusy = true;
		try {
			await agent.run({ id: "scheduled", messages: [], approveAll: true }, prompt, {});
		} finally {
			this.agentBusy = false;
		}
		return overlay.changes();
	}

	private async runDigestJob() {
		const now = new Date();
		const weekOf = localDate(now);
		const path = digestPath(this.settings.digestFolder, weekOf);
		const notes = recentNotes(this.vault.listNotes(), now, 7).filter((n) => !n.path.startsWith(this.settings.digestFolder.replace(/\/+$/, "") + "/"));
		if (notes.length === 0) return [];
		const texts: { path: string; text: string }[] = [];
		let budget = 40000;
		for (const n of notes.slice(0, 40)) {
			if (budget <= 500) break;
			const text = (await this.vault.read(n.path)).slice(0, Math.min(4000, budget));
			budget -= text.length;
			texts.push({ path: n.path, text });
		}
		const res = await this.client.chat({
			model: this.settings.model,
			messages: [{ role: "user", content: digestPrompt(weekOf, texts) }],
			think: false,
			options: { num_ctx: this.settings.numCtx, temperature: 0.4 },
			keep_alive: this.settings.keepAlive,
		});
		const content = renderDigest(weekOf, res.message.content, notes);
		if (this.vault.exists(path)) return [{ path, tool: "edit_note" as const, before: await this.vault.read(path), after: content }];
		return [{ path, tool: "create_note" as const, before: "", after: content }];
	}

	/** A notice (once per batch, when the user is at the keyboard) and the status-bar badge for waiting changes. */
	private notifyPending(force = false): void {
		this.updateStatusBar();
		const n = this.pending.size;
		if (n === 0) return;
		const present = Date.now() - this.lastActivity < 2 * 60_000;
		if (!force && (!present || this.pendingNotified === n)) return;
		this.pendingNotified = n;
		const frag = createFragment();
		frag.createSpan({ text: `Local Vault Agent: ${n} change${n === 1 ? "" : "s"} from scheduled jobs wait for your review. ` });
		const btn = frag.createEl("button", { text: "Review now" });
		btn.addEventListener("click", () => void this.reviewPending());
		new Notice(frag, 15000);
	}

	private updateStatusBar(): void {
		if (!this.statusBar) return;
		const n = this.pending.size;
		this.statusBar.setText(n ? `🤖 ${n} to review` : "");
		this.statusBar.toggle(n > 0);
		this.statusBar.setAttribute("aria-label", n ? `${n} change${n === 1 ? "" : "s"} from scheduled jobs: click to review` : "");
	}

	/** Walks the queued changes as diffs: approve writes, reject drops, a change that no longer fits is dropped with a notice. */
	async reviewPending(): Promise<void> {
		if (this.pending.size === 0) {
			new Notice("No scheduled changes waiting.");
			return;
		}
		let approveAll = false;
		let applied = 0;
		for (const item of [...this.pending.list()]) {
			const plan = await planPending(item, this.vault);
			if (!plan.ok) {
				new Notice(`Skipped: ${plan.reason}`, 8000);
				this.pending.remove(item.id);
				continue;
			}
			if (!approveAll) {
				const modal = new ApprovalModal(this.app, { tool: item.tool, path: item.path, before: plan.before, after: plan.after, summary: `${item.summary} (${new Date(item.time).toLocaleString()})` });
				modal.open();
				const decision = await modal.result;
				if (decision === "reject") {
					this.pending.remove(item.id);
					continue;
				}
				if (decision === "approve-all") approveAll = true;
			}
			try {
				if (item.tool === "create_note") {
					const folder = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
					if (folder && !this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
					await this.vault.create(item.path, plan.after);
				} else await this.vault.modify(item.path, plan.after);
				this.undo.push({ tool: item.tool, path: item.path, before: plan.before, after: plan.after, time: Date.now(), turn: item.time, chat: "scheduled", summary: item.summary });
				applied++;
			} catch (err) {
				new Notice(`Could not write ${item.path}: ${(err as Error).message}`, 8000);
			}
			this.pending.remove(item.id);
		}
		if (applied) new Notice(`Applied ${applied} scheduled change${applied === 1 ? "" : "s"}.`);
	}

	/** One page of a PDF as a PNG, for the vision model (scanned pages have no text layer). */
	private async renderPdfPage(path: string, pageNumber: number): Promise<ArrayBuffer> {
		const file = this.app.vault.getFileByPath(normalizePath(path));
		if (!file) throw new Error(`File not found: ${path}`);
		const pdfjs = (await loadPdfJs()) as {
			getDocument(src: { data: ArrayBuffer }): {
				promise: Promise<{
					numPages: number;
					getPage(n: number): Promise<{
						getViewport(o: { scale: number }): { width: number; height: number };
						render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
					}>;
				}>;
			};
		};
		const doc = await pdfjs.getDocument({ data: await this.app.vault.readBinary(file) }).promise;
		if (pageNumber > doc.numPages) throw new Error(`${path} has ${doc.numPages} pages.`);
		const page = await doc.getPage(pageNumber);
		const viewport = page.getViewport({ scale: 2 });
		const canvas = createEl("canvas");
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Cannot render the PDF page here.");
		await page.render({ canvasContext: ctx, viewport }).promise;
		const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
		if (!blob) throw new Error("Cannot render the PDF page here.");
		return blob.arrayBuffer();
	}

	/** Subscribe to gist generation status. Returns an unsubscribe function. */
	onGistStatus(listener: (s: GistStatus) => void): () => void {
		this.gistListeners.add(listener);
		return () => this.gistListeners.delete(listener);
	}

	/** Subscribe to index status changes. Returns an unsubscribe function. */
	onIndexStatus(listener: (s: IndexStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	agentConfig(): AgentConfig {
		const s = this.settings;
		return {
			model: s.model,
			numCtx: s.numCtx,
			temperature: s.temperature,
			sampling: SAMPLING,
			think: s.thinking === "auto" ? undefined : s.thinking === "on",
			keepAlive: s.keepAlive,
			maxIterations: s.maxIterations,
			maxToolResultChars: s.maxToolResultChars,
			autoApprove: s.autoApproveEdits,
			autoContinue: s.autoContinue,
			extraSystemPrompt: s.extraSystemPrompt,
			citations: s.citations,
			answerLanguage: s.answerLanguage,
		};
	}

	async hybridSearch(query: string, limit: number): Promise<SearchHit[]> {
		// Bodies come from the index's memory when the note is indexed and unchanged: at tens of
		// thousands of notes, reading every file from disk for each search is what made it slow.
		const notes = this.vault.listNotes();
		// (Below 2,000 notes the files are read as before, frontmatter included, which is what the accuracy benchmark measures.)
		// The index holds no frontmatter, so above that the properties come from Obsidian's metadata cache (also in memory).
		const textOf = (n: NoteInfo): string | undefined => {
			const body = this.index.textFor(n.path, n.mtime);
			if (body === undefined) return undefined; // not indexed, or changed since: read the file
			const head = frontmatterText(this.app.metadataCache.getCache(n.path)?.frontmatter);
			return head ? `${head}\n${body}` : body;
		};
		const keyword = await keywordSearch(this.vault, query, limit * 2, notes, notes.length > 2000 ? textOf : undefined);
		if (!this.index.ready) return keyword.slice(0, limit);
		try {
			const semantic = await this.index.search(query, limit * 2);
			return fuseRankings([semantic, keyword], limit);
		} catch {
			return keyword.slice(0, limit);
		}
	}

	async activateView(): Promise<AgentView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return null;
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		return leaf.view instanceof AgentView ? leaf.view : null;
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<LocalVaultAgentSettings> | null;
		this.settings = migrateSettings(data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
