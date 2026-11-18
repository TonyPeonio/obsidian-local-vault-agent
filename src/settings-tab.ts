import { chatModelOptions } from "./model-picker";
import { sameModel } from "./ollama";
import { App, Notice, PluginSettingTab, Setting, normalizePath, requireApiVersion, type SettingDefinitionItem } from "obsidian";
import { hasKey, t, type I18nKey } from "./i18n";
import type LocalVaultAgentPlugin from "./main";
import { TuneModal } from "./prompt-modals";
import { conventionsTemplate } from "./prompts";
import { DEFAULT_SETTINGS } from "./settings";
import { measure, recommend } from "./tune";

/** One settings row: its name and description (also what settings search matches) and how to fill it. */
interface Row {
	name: string;
	desc?: string;
	aliases?: string[];
	visible?: () => boolean;
	render: (s: Setting) => void;
}

interface Group {
	heading: string;
	about?: string;
	rows: Row[];
}

/**
 * The settings, written once as data: Obsidian 1.13+ renders them declaratively (so every setting
 * shows up in Obsidian's settings search); older versions get the same rows through `display()`.
 */
export class LocalVaultAgentSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: LocalVaultAgentPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.groups().map((g) => ({
			type: "group" as const,
			heading: g.heading,
			items: [
				...(g.about ? [{ name: g.heading, desc: g.about, render: () => {} }] : []),
				...g.rows.map((r) => ({
					name: r.name,
					desc: r.desc,
					aliases: r.aliases,
					visible: r.visible,
					// A block body on purpose: Obsidian keeps whatever `render` returns as the row's cleanup
					// function, and most rows return their Setting, which is not callable.
					render: (setting: Setting) => {
						r.render(setting);
					},
				})),
			],
		}));
	}

	/** Pre-1.13 Obsidian: the same rows, rendered by hand. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const g of this.groups()) {
			new Setting(containerEl).setName(g.heading).setHeading();
			if (g.about) containerEl.createEl("p", { cls: "setting-item-description", text: g.about });
			for (const r of g.rows) {
				if (r.visible && !r.visible()) continue;
				const s = new Setting(containerEl).setName(r.name);
				if (r.desc) s.setDesc(r.desc);
				r.render(s);
			}
		}
	}

	/** Re-renders after a change that alters which rows exist or what they say. */
	private refresh(): void {
		if (requireApiVersion("1.13.0")) {
			this.update();
			this.refreshDomState();
		} else this.display();
	}

	private row(key: string, render: (s: Setting) => void, extra: Partial<Row> = {}): Row {
		const nameKey = `${key}.name`;
		const descKey = `${key}.desc`;
		return { name: hasKey(nameKey) ? t(nameKey) : key, desc: hasKey(descKey) ? t(descKey) : undefined, render, ...extra };
	}

	private groups(): Group[] {
		const p = this.plugin;
		const s = p.settings;
		const save = () => p.saveSettings();
		const isOllama = () => p.settings.provider === "ollama";
		return [
			{
				heading: t("set.h.server"),
				rows: [
					this.row("set.provider", (st) =>
						st.addDropdown((d) =>
							d
								.addOptions({ ollama: t("set.provider.ollama"), openai: t("set.provider.openai") })
								.setValue(s.provider)
								.onChange(async (v) => {
									s.provider = v as typeof s.provider;
									await save();
									void p.refreshVision();
									this.refresh();
								}),
						),
					{ aliases: ["LM Studio", "llama.cpp", "Jan", "vLLM", "OpenAI"] }),
					this.row(
						"set.url",
						(st) =>
							st
								.addText((tx) =>
									tx.setPlaceholder(DEFAULT_SETTINGS.ollamaUrl).setValue(s.ollamaUrl).onChange(async (v) => {
										s.ollamaUrl = v.trim() || DEFAULT_SETTINGS.ollamaUrl;
										await save();
									}),
								)
								.addButton((b) => b.setButtonText(t("set.test.button")).onClick(() => void this.testConnection())),
						{ visible: isOllama },
					),
					this.row(
						"set.oaUrl",
						(st) =>
							st
								.addText((tx) =>
									tx.setPlaceholder(DEFAULT_SETTINGS.openaiUrl).setValue(s.openaiUrl).onChange(async (v) => {
										s.openaiUrl = v.trim() || DEFAULT_SETTINGS.openaiUrl;
										await save();
									}),
								)
								.addButton((b) => b.setButtonText(t("set.test.button")).onClick(() => void this.testConnection())),
						{ visible: () => !isOllama() },
					),
					this.row(
						"set.oaKey",
						(st) =>
							st.addText((tx) => {
								tx.inputEl.type = "password";
								tx.setValue(s.openaiKey).onChange(async (v) => {
									s.openaiKey = v.trim();
									await save();
								});
							}),
						{ visible: () => !isOllama() },
					),
					{
						name: t("set.lc.name"),
						// Only for Ollama: the copy writes an Ollama URL and model tag, which an OpenAI-compatible
						// server would not know.
						visible: () => isOllama() && p.lectureCompanion() !== null,
						render: (st) => {
							// Read here, not in groups(): Obsidian 1.13+ builds the definitions once at plugin load,
							// when Lecture Companion may not have loaded yet, but renders on every open.
							const lc = p.lectureCompanion();
							if (lc) st.setDesc(t("set.lc.desc", { url: lc.ollama().url, model: lc.ollama().model }));
							st.addButton((b) =>
								b.setButtonText(t("set.lc.name")).onClick(async () => {
									await p.useLectureCompanionOllama();
									new Notice(`${p.settings.ollamaUrl} · ${p.settings.model}`);
									void p.refreshVision();
									this.refresh();
								}),
							);
						},
					},
					this.row("set.model", (st) => {
						st.addDropdown(async (d) => {
							d.addOption(s.model, s.model);
							d.setValue(s.model);
							try {
								const models = await p.client.listModels();
								d.selectEl.empty();
								// The same list as the picker in the chat: only models the agent can use, with their size.
								const options = chatModelOptions(models, [], s.model);
								for (const o of options) d.addOption(o.value, o.label);
								d.setValue(options.find((o) => o.current)?.value ?? s.model);
							} catch {
								// Keep the single current value when the server is unreachable.
							}
							d.onChange(async (v) => {
								s.model = v;
								await save();
								void p.refreshVision();
							});
						});
						st.addText((tx) =>
							tx.setPlaceholder(t("set.model.placeholder")).onChange(async (v) => {
								if (!v.trim()) return;
								s.model = v.trim();
								await save();
							}),
						);
					}),
					this.row("set.ctx", (st) =>
						st.addText((tx) =>
							tx.setValue(String(s.numCtx)).onChange(async (v) => {
								const n = parseInt(v, 10);
								if (Number.isFinite(n) && n >= 2048 && n <= 262144) {
									s.numCtx = n;
									await save();
								}
							}),
						),
					),
					this.row("set.temp", (st) =>
						st.addSlider((sl) =>
							sl.setLimits(0, 1, 0.05).setValue(s.temperature).onChange(async (v) => {
								s.temperature = v;
								await save();
							}),
						),
					),
					this.row("set.think", (st) =>
						st.addDropdown((d) =>
							d
								.addOptions({ auto: t("set.think.auto"), on: t("set.think.on"), off: t("set.think.off") })
								.setValue(s.thinking)
								.onChange(async (v) => {
									s.thinking = v as typeof s.thinking;
									await save();
								}),
						),
					),
					this.row("set.showThinking", (st) =>
						st.addToggle((tg) =>
							tg.setValue(s.showThinking).onChange(async (v) => {
								s.showThinking = v;
								await save();
							}),
						),
					),
					this.row(
						"set.keepAlive",
						(st) =>
							st.addText((tx) =>
								tx.setValue(s.keepAlive).onChange(async (v) => {
									s.keepAlive = v.trim() || DEFAULT_SETTINGS.keepAlive;
									await save();
								}),
							),
						{ visible: isOllama },
					),
					this.row("set.vision", (st) =>
						st
							.addText((tx) =>
								tx.setPlaceholder(t("set.vision.placeholder")).setValue(s.visionModel).onChange(async (v) => {
									s.visionModel = v.trim();
									await save();
									void p.refreshVision();
								}),
							)
							.addButton((b) =>
								b.setButtonText(t("set.vision.check")).onClick(async () => {
									await p.refreshVision();
									const model = await p.vision.model();
									new Notice(model ? `Images will be read with ${model}.` : "No vision model: the chat model cannot see and none is set. Install one, e.g. ollama pull qwen2.5vl:7b.", 8000);
								}),
							),
					),
					this.row(
						"set.lang",
						(st) =>
							st.addText((tx) =>
								tx.setPlaceholder(t("set.lang.placeholder")).setValue(s.answerLanguage).onChange(async (v) => {
									s.answerLanguage = v.trim();
									await save();
								}),
							),
						{ aliases: ["language", "translate"] },
					),
				],
			},
			{
				heading: t("set.h.search"),
				rows: [
					this.row("set.semantic", (st) =>
						st.addToggle((tg) =>
							tg.setValue(s.semanticSearch).onChange(async (v) => {
								s.semanticSearch = v;
								await save();
								if (v) void p.index.syncAll();
								else p.index.cancel();
								this.refresh();
							}),
						),
					),
					this.row(
						"set.embed",
						(st) =>
							st.addText((tx) =>
								tx.setValue(s.embeddingModel).onChange(async (v) => {
									s.embeddingModel = v.trim() || DEFAULT_SETTINGS.embeddingModel;
									await save();
								}),
							),
						{ visible: () => p.settings.semanticSearch },
					),
					{
						name: t("set.index.name"),
						visible: () => p.settings.semanticSearch,
						render: (st) => {
							const status = p.index.status();
							st.setDesc(
								status.building
									? t("set.index.building", { done: status.indexedFiles, pending: status.pending })
									: status.lastError
										? t("set.index.error", { error: status.lastError })
										: t("set.index.ready", { notes: status.indexedFiles, chunks: status.totalChunks }),
							);
							st.addButton((b) =>
								b.setButtonText(t("set.index.update")).onClick(async () => {
									await p.index.syncAll();
									this.refresh();
								}),
							).addButton((b) =>
								b.setButtonText(t("set.index.rebuild")).onClick(async () => {
									await p.index.syncAll(true);
									this.refresh();
								}),
							);
						},
					},
					this.row("set.excluded", (st) =>
						st.addTextArea((tx) =>
							tx.setValue(s.excludedFolders.join("\n")).onChange(async (v) => {
								s.excludedFolders = v.split("\n").map((l) => l.trim()).filter(Boolean);
								await save();
							}),
						),
					),
					this.row("set.gists", (st) =>
						st
							.addToggle((tg) =>
								tg.setValue(s.gists).onChange(async (v) => {
									s.gists = v;
									await save();
									if (v) void p.gists.syncAll();
								}),
							)
							.addButton((b) =>
								b.setButtonText(t("set.gists.rebuild")).onClick(() => {
									void p.gists.syncAll(true);
								}),
							),
					),
				],
			},
			{
				heading: t("set.h.agent"),
				rows: [
					this.row("set.autoApprove", (st) =>
						st.addToggle((tg) =>
							tg.setValue(s.autoApproveEdits).onChange(async (v) => {
								s.autoApproveEdits = v;
								await save();
							}),
						),
					),
					this.row("set.autoContinue", (st) =>
						st.addToggle((tg) =>
							tg.setValue(s.autoContinue).onChange(async (v) => {
								s.autoContinue = v;
								await save();
							}),
						),
					),
					this.row("set.maxIter", (st) =>
						st.addSlider((sl) =>
							sl.setLimits(3, 150, 1).setValue(s.maxIterations).onChange(async (v) => {
								s.maxIterations = v;
								await save();
							}),
						),
					),
					this.row("set.maxChars", (st) =>
						st.addText((tx) =>
							tx.setValue(String(s.maxToolResultChars)).onChange(async (v) => {
								const n = parseInt(v, 10);
								if (Number.isFinite(n) && n >= 1000 && n <= 200000) {
									s.maxToolResultChars = n;
									await save();
								}
							}),
						),
					),
					this.row("set.conventions", (st) =>
						st
							.addText((tx) =>
								tx.setPlaceholder(DEFAULT_SETTINGS.conventionsNote).setValue(s.conventionsNote).onChange(async (v) => {
									s.conventionsNote = v.trim() || DEFAULT_SETTINGS.conventionsNote;
									await save();
								}),
							)
							.addButton((b) =>
								b.setButtonText(t("set.conventions.button")).onClick(async () => {
									let path = p.vault.resolve(s.conventionsNote);
									if (!path) {
										path = normalizePath(/\.md$/i.test(s.conventionsNote) ? s.conventionsNote : `${s.conventionsNote}.md`);
										await p.vault.create(path, conventionsTemplate());
										new Notice(`Created ${path}. Edit it like any note.`);
									}
									await this.app.workspace.openLinkText(path, "", true);
								}),
							),
					),
					this.row("set.inbox", (st) =>
						st.addText((tx) =>
							tx.setPlaceholder(DEFAULT_SETTINGS.dailyInboxHeading).setValue(s.dailyInboxHeading).onChange(async (v) => {
								s.dailyInboxHeading = v.trim() || DEFAULT_SETTINGS.dailyInboxHeading;
								await save();
							}),
						),
					),
					this.row("set.topics", (st) =>
						st.addText((tx) =>
							tx.setPlaceholder(DEFAULT_SETTINGS.dailyTopicsFolder).setValue(s.dailyTopicsFolder).onChange(async (v) => {
								s.dailyTopicsFolder = v.trim();
								await save();
							}),
						),
					),
					this.row("set.citations", (st) =>
						st.addDropdown((d) =>
							d
								.addOptions({ blocks: t("set.citations.blocks"), headings: t("set.citations.headings"), off: t("set.citations.off") })
								.setValue(s.citations)
								.onChange(async (v) => {
									s.citations = v as typeof s.citations;
									await save();
								}),
						),
					),
					this.row("set.extra", (st) =>
						st.addTextArea((tx) => {
							tx.setValue(s.extraSystemPrompt).onChange(async (v) => {
								s.extraSystemPrompt = v;
								await save();
							});
							tx.inputEl.rows = 5;
							tx.inputEl.addClass("lva-settings-textarea");
						}),
					),
				],
			},
			{
				heading: t("set.h.study"),
				rows: [
					this.row("set.concepts", (st) =>
						st.addTextArea((tx) => {
							tx.setValue(s.conceptFolders.join("\n")).onChange(async (v) => {
								s.conceptFolders = v.split("\n").map((l) => l.trim()).filter(Boolean);
								await save();
							});
							tx.inputEl.rows = 3;
						}),
					),
					this.row("set.quizN", (st) =>
						st.addSlider((sl) =>
							sl.setLimits(3, 15, 1).setValue(s.quizQuestions).onChange(async (v) => {
								s.quizQuestions = v;
								await save();
							}),
						),
					),
					this.row("set.quizFolder", (st) =>
						st.addText((tx) =>
							tx.setPlaceholder(DEFAULT_SETTINGS.quizReviewFolder).setValue(s.quizReviewFolder).onChange(async (v) => {
								s.quizReviewFolder = v.trim();
								await save();
							}),
						),
					),
					{
						name: t("set.lcStatus.name"),
						// The static text keeps the row in settings search; `render` runs on every open and
						// says what is true now (the definitions are built once, at plugin load).
						desc: t("set.lcStatus.off"),
						render: (st) => {
							st.setDesc(p.lectureCompanion() ? t("set.lcStatus.on") : t("set.lcStatus.off"));
						},
					},
				],
			},
			{
				heading: t("set.h.schedule"),
				about: t("set.schedule.about"),
				rows: [
					this.row("set.nightly", (st) =>
						st.addToggle((tg) =>
							tg.setValue(s.nightlyDaily).onChange(async (v) => {
								s.nightlyDaily = v;
								if (v) s.jobRuns.daily = Date.now();
								await save();
							}),
						),
					),
					this.row("set.nightlyTime", (st) => this.timeInput(st, () => s.nightlyTime, (v) => (s.nightlyTime = v))),
					this.row("set.digest", (st) =>
						st.addToggle((tg) =>
							tg.setValue(s.weeklyDigest).onChange(async (v) => {
								s.weeklyDigest = v;
								if (v) s.jobRuns.digest = Date.now();
								await save();
							}),
						),
					),
					this.row("set.digestDay", (st) =>
						st.addDropdown((d) =>
							d
								.addOptions(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((n) => [String(n), t(`day.${n}` as I18nKey)])))
								.setValue(String(s.digestDay))
								.onChange(async (v) => {
									s.digestDay = Number(v);
									await save();
								}),
						),
					),
					this.row("set.digestTime", (st) => this.timeInput(st, () => s.digestTime, (v) => (s.digestTime = v))),
					this.row("set.digestFolder", (st) =>
						st.addText((tx) =>
							tx.setPlaceholder(DEFAULT_SETTINGS.digestFolder).setValue(s.digestFolder).onChange(async (v) => {
								s.digestFolder = v.trim();
								await save();
							}),
						),
					),
					{
						name: t("set.pending.name"),
						render: (st) => {
							const waiting = p.pending.size;
							st.setDesc(waiting ? t("set.pending.some", { n: waiting }) : t("set.pending.none"));
							st.addButton((b) =>
								b
									.setButtonText(t("set.pending.button"))
									.setDisabled(waiting === 0)
									.onClick(() => void p.reviewPending()),
							);
						},
					},
				],
			},
			{
				heading: t("set.h.help"),
				rows: [
					this.row("set.setup", (st) => st.addButton((b) => b.setButtonText(t("set.setup.button")).onClick(() => p.openSetup()))),
					this.row("set.sample", (st) => st.addButton((b) => b.setButtonText(t("set.sample.button")).onClick(() => void p.trySample()))),
					this.row("set.report", (st) => st.addButton((b) => b.setButtonText(t("set.report.button")).onClick(() => p.reportProblem())), { aliases: ["bug", "issue", "feedback"] }),
				],
			},
		];
	}

	private timeInput(st: Setting, get: () => string, set: (v: string) => void): void {
		st.addText((tx) => {
			tx.inputEl.type = "time";
			tx.setValue(get()).onChange(async (v) => {
				if (!/^\d{1,2}:\d{2}$/.test(v)) return;
				set(v);
				await this.plugin.saveSettings();
			});
		});
	}

	/** A short generation at the configured context: connection, speed, memory split, advice. */
	private async testConnection(): Promise<void> {
		const p = this.plugin;
		const s = p.settings;
		let models;
		let connection = "";
		try {
			const version = await p.client.version();
			models = await p.client.listModels();
			const hasChat = models.some((m) => sameModel(m.name, s.model));
			const hasEmbed = models.some((m) => sameModel(m.name, s.embeddingModel));
			connection =
				`Connected to ${s.provider === "ollama" ? `Ollama ${version}` : version} (${models.length} models).` +
				(hasChat ? "" : ` Chat model "${s.model}" is not available${s.provider === "ollama" ? `: run \`ollama pull ${s.model}\`` : ""}.`) +
				(s.semanticSearch && !hasEmbed ? ` Embedding model "${s.embeddingModel}" is not available.` : "");
			if (!hasChat || s.provider !== "ollama") {
				new Notice(connection, 10000);
				return;
			}
		} catch (err) {
			p.logError(`Connection test: ${(err as Error).message}`);
			new Notice(`Connection failed: ${(err as Error).message}`, 10000);
			return;
		}
		const working = new Notice(`Measuring ${s.model} at a ${Math.round(s.numCtx / 1024)}k context… (loads the model if needed)`, 0);
		try {
			const measured = await measure(p.client, s.model, s.numCtx, s.keepAlive);
			working.hide();
			const advice = recommend(measured, models);
			const modal = new TuneModal(this.app, advice, connection);
			modal.open();
			const choice = await modal.result;
			if (!choice) return;
			if (choice.numCtx) s.numCtx = choice.numCtx;
			if (choice.model) s.model = choice.model;
			await p.saveSettings();
			this.refresh();
			new Notice(choice.numCtx ? `Context set to ${choice.numCtx}. Test again to confirm it still fits.` : `Chat model set to ${choice.model}.`);
		} catch (err) {
			working.hide();
			p.logError(`Speed test: ${(err as Error).message}`);
			new Notice(`${connection}\nSpeed test failed: ${(err as Error).message}`, 10000);
		}
	}
}
