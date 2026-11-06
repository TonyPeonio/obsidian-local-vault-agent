import { Notice, Plugin, TFile, WorkspaceLeaf, requestUrl } from "obsidian";
import { Agent, type AgentConfig } from "./agent";
import { ApprovalModal } from "./approval-modal";
import { SemanticIndex, type IndexData, type IndexStatus } from "./index";
import { ObsidianVault } from "./obsidian-vault";
import { OllamaClient } from "./ollama";
import { reformatPrompt, summarizePrompt } from "./prompts";
import { fuseRankings, keywordSearch } from "./search";
import { DEFAULT_SETTINGS, isExcluded, type LocalVaultAgentSettings } from "./settings";
import { LocalVaultAgentSettingTab } from "./settings-tab";
import { ALL_TOOLS } from "./tools";
import type { ChangeRecord, SearchHit } from "./types";
import { UndoStack, describeChange, planRevert } from "./undo";
import { AgentView, VIEW_TYPE } from "./view";

export default class LocalVaultAgentPlugin extends Plugin {
	settings: LocalVaultAgentSettings = { ...DEFAULT_SETTINGS };
	client!: OllamaClient;
	vault!: ObsidianVault;
	index!: SemanticIndex;
	agent!: Agent;
	/** Every approved write this session, newest last; survives "New chat". */
	readonly undo = new UndoStack();
	private statusListeners = new Set<(s: IndexStatus) => void>();

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
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					void (async () => {
						const content = await this.app.vault.cachedRead(file);
						const view = await this.activateView();
						await view?.send(reformatPrompt(file.path, content));
					})();
				}
				return true;
			},
		});
		this.addCommand({
			id: "summarize-current-note",
			name: "Summarize the current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					void this.activateView().then((view) => view?.send(summarizePrompt(file.path)));
				}
				return true;
			},
		});
		this.addCommand({
			id: "undo-last-change",
			name: "Undo the agent's last change",
			checkCallback: (checking) => {
				const latest = this.undo.latest();
				if (!latest) return false;
				if (!checking) void this.revert(latest);
				return true;
			},
		});
		this.addCommand({
			id: "undo-last-message",
			name: "Undo every change from the agent's last message",
			checkCallback: (checking) => {
				const latest = this.undo.latest();
				if (!latest) return false;
				if (!checking) void this.revertTurn(latest.turn);
				return true;
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
				}, 2000),
			);
		};
		this.register(() => timers.forEach((t) => window.clearTimeout(t)));
		this.registerEvent(this.app.vault.on("modify", (f) => f instanceof TFile && f.extension === "md" && changed(f)));
		this.registerEvent(this.app.vault.on("create", (f) => f instanceof TFile && f.extension === "md" && changed(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => f instanceof TFile && this.index.remove(f.path)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => f instanceof TFile && this.index.rename(old, f.path)));

		this.app.workspace.onLayoutReady(async () => {
			await this.index.load();
			if (this.settings.semanticSearch) void this.index.syncAll();
		});
	}

	onunload(): void {
		this.index.cancel();
		void this.index.flush();
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
