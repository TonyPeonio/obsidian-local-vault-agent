import { Notice, Plugin, TFile, WorkspaceLeaf, loadPdfJs, moment, normalizePath, requestUrl } from "obsidian";
import { Agent, type AgentConfig } from "./agent";
import { ApprovalModal } from "./approval-modal";
import { GistCache, type GistData, type GistStatus } from "./gists";
import { SemanticIndex, type IndexData, type IndexStatus } from "./index";
import { ObsidianVault } from "./obsidian-vault";
import { OllamaClient } from "./ollama";
import { reformatPrompt, summarizePrompt } from "./prompts";
import { fuseRankings, keywordSearch } from "./search";
import { DEFAULT_SETTINGS, isExcluded, type LocalVaultAgentSettings } from "./settings";
import { LocalVaultAgentSettingTab } from "./settings-tab";
import { ALL_TOOLS } from "./tools";
import type { ChangeRecord, ChatMessage, SearchHit } from "./types";
import { UndoStack, describeChange, planRevert } from "./undo";
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
	/** Every approved write this session, newest last; survives "New chat". */
	readonly undo = new UndoStack();
	private statusListeners = new Set<(s: IndexStatus) => void>();
	private gistListeners = new Set<(s: GistStatus) => void>();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.client = new OllamaClient(
			() => this.settings.ollamaUrl,
			// `fetch` is deliberate: `requestUrl` cannot stream, and streaming tokens from a slow
			// local model is the whole experience. `requestUrl` is used as the CORS-free fallback.
			(input, init) => fetch(input, init),
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
		);
		this.vault = new ObsidianVault(this.app, (p) => isExcluded(p, this.settings.excludedFolders));

		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		const indexPath = `${pluginDir}/index.json`;
		this.index = new SemanticIndex(
			this.client,
			this.vault,
			{
				load: async () => {
					if (!(await this.app.vault.adapter.exists(indexPath))) return null;
					return JSON.parse(await this.app.vault.adapter.read(indexPath)) as IndexData;
				},
				save: async (data) => {
					await this.app.vault.adapter.write(indexPath, JSON.stringify(data));
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
			dailyNote: () => this.dailyNote(),
			readConventions: async () => {
				const path = this.vault.resolve(this.settings.conventionsNote);
				return path ? this.vault.read(path) : null;
			},
		});

		this.registerView(VIEW_TYPE, (leaf) => new AgentView(leaf, this));
		this.addRibbonIcon("bot", "Open Local Vault Agent", () => void this.activateView());
		this.addSettingTab(new LocalVaultAgentSettingTab(this.app, this));

		this.addCommand({
			id: "open-chat",
			name: "Open chat",
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: "ask-about-selection",
			name: "Ask about the selected text",
			editorCallback: async (editor) => {
				const sel = editor.getSelection();
				const view = await this.activateView();
				view?.prefill(sel ? `About this selected text:\n"""\n${sel}\n"""\n\n` : "");
			},
		});
		this.addCommand({
			id: "reformat-current-note",
			name: "Reformat the current note",
			checkCallback: (checking) => {
				if (!this.activeNote()) return false;
				if (!checking) void this.reformatCurrentNote();
				return true;
			},
		});
		this.addCommand({
			id: "summarize-current-note",
			name: "Summarize the current note",
			checkCallback: (checking) => {
				if (!this.activeNote()) return false;
				if (!checking) void this.summarizeCurrentNote();
				return true;
			},
		});
		this.addCommand({
			id: "undo-last-change",
			name: "Undo the agent's last change",
			checkCallback: (checking) => {
				if (!this.undo.latest()) return false;
				if (!checking) void this.undoLast();
				return true;
			},
		});
		this.addCommand({
			id: "undo-last-message",
			name: "Undo every change from the agent's last message",
			checkCallback: (checking) => {
				if (!this.undo.latest()) return false;
				if (!checking) void this.undoLastTurn();
				return true;
			},
		});
		this.addCommand({
			id: "rebuild-gists",
			name: "Rebuild note gists",
			callback: async () => {
				new Notice("Regenerating gists for every note in the background…");
				await this.gists.syncAll(true);
				const s = this.gists.status();
				new Notice(s.lastError ? `Gist error: ${s.lastError}` : `Gists ready for ${s.done} notes.`);
			},
		});
		this.addCommand({
			id: "rebuild-index",
			name: "Rebuild semantic index",
			callback: async () => {
				new Notice("Rebuilding the semantic index…");
				await this.index.syncAll(true);
				const s = this.index.status();
				new Notice(s.lastError ? `Index error: ${s.lastError}` : `Indexed ${s.indexedFiles} notes.`);
			},
		});

		// Keep the index in step with the vault. Debounce per path so a burst of edits to one
		// note embeds once, while edits to different notes are all picked up.
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
				}, 2000),
			);
		};
		this.register(() => timers.forEach((t) => window.clearTimeout(t)));
		this.registerEvent(this.app.vault.on("modify", (f) => f instanceof TFile && f.extension === "md" && changed(f)));
		this.registerEvent(this.app.vault.on("create", (f) => f instanceof TFile && f.extension === "md" && changed(f)));
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
			await this.loadDailyNoteSettings();
			void this.checkOllamaOnce();
			await this.index.load();
			await this.gists.load();
			// Embeddings first (fast, small model), then gists (chat model), so they never run together.
			void (async () => {
				if (this.settings.semanticSearch) await this.index.syncAll();
				if (this.settings.gists) await this.gists.syncAll();
			})();
		});
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
			const data = JSON.parse(await this.app.vault.adapter.read(this.chatPath)) as { messages?: ChatMessage[] };
			return Array.isArray(data.messages) ? data.messages : null;
		} catch {
			return null;
		}
	}

	saveChat(messages: ChatMessage[]): void {
		if (!this.chatPath) return;
		if (this.chatSaveTimer !== null) window.clearTimeout(this.chatSaveTimer);
		this.chatSaveTimer = window.setTimeout(() => {
			this.chatSaveTimer = null;
			// Thinking is dropped: it is large and never shown again.
			const slim = messages.map((m) => (m.thinking ? { ...m, thinking: undefined } : m));
			void this.app.vault.adapter.write(this.chatPath, JSON.stringify({ messages: slim }));
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
			if (!models.some((m) => m.name === this.settings.model)) missing.push(this.settings.model);
			if (this.settings.semanticSearch && !models.some((m) => m.name === this.settings.embeddingModel)) missing.push(this.settings.embeddingModel);
			if (missing.length) {
				new Notice(`Local Vault Agent: model${missing.length === 1 ? "" : "s"} not installed: ${missing.join(", ")}. Run \`ollama pull ${missing[0]}\` or pick another model in settings.`, 12000);
			}
		} catch (err) {
			new Notice(`Local Vault Agent cannot reach Ollama at ${this.settings.ollamaUrl} (${(err as Error).message}). Start Ollama or fix the URL in settings.`, 12000);
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

	private activeNote(): TFile | null {
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
		await this.revertTurn(latest.turn);
	}

	/**
	 * Undo one recorded change. The restore is shown as a diff (current → restored) and only
	 * applied when approved, exactly like the change itself was.
	 */
	async revert(change: ChangeRecord): Promise<boolean> {
		let plan;
		try {
			plan = await planRevert(change, this.vault);
		} catch (err) {
			new Notice((err as Error).message, 6000);
			this.undo.remove(change.id);
			return false;
		}
		const modal = new ApprovalModal(this.app, plan);
		modal.open();
		const decision = await modal.result;
		if (decision === "reject") return false;
		try {
			await plan.apply();
		} catch (err) {
			new Notice(`Undo failed: ${(err as Error).message}`, 8000);
			return false;
		}
		this.undo.remove(change.id);
		new Notice(`Undone: ${describeChange(change)}.`);
		return true;
	}

	/** Undo every change of one agent turn, newest first, stopping at the first rejection. */
	async revertTurn(turn: number): Promise<void> {
		const changes = this.undo.forTurn(turn);
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
			think: s.thinking === "auto" ? undefined : s.thinking === "on",
			keepAlive: s.keepAlive,
			maxIterations: s.maxIterations,
			maxToolResultChars: s.maxToolResultChars,
			autoApprove: s.autoApproveEdits,
			autoContinue: s.autoContinue,
			extraSystemPrompt: s.extraSystemPrompt,
		};
	}

	async hybridSearch(query: string, limit: number): Promise<SearchHit[]> {
		const keyword = await keywordSearch(this.vault, query, limit * 2);
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
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
