import { sameModel } from "./ollama";
import { App, Notice, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type LocalVaultAgentPlugin from "./main";
import { TuneModal } from "./prompt-modals";
import { conventionsTemplate } from "./prompts";
import { DEFAULT_SETTINGS } from "./settings";
import { measure, recommend } from "./tune";

export class LocalVaultAgentSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: LocalVaultAgentPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName("Ollama").setHeading();

		new Setting(containerEl)
			.setName("Ollama URL")
			.setDesc("Where Ollama is listening. Use a LAN address on mobile.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.ollamaUrl).setValue(s.ollamaUrl).onChange(async (v) => {
					s.ollamaUrl = v.trim() || DEFAULT_SETTINGS.ollamaUrl;
					await this.plugin.saveSettings();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Test connection and speed").onClick(async () => {
					let models;
					let connection = "";
					try {
						const version = await this.plugin.client.version();
						models = await this.plugin.client.listModels();
						const hasChat = models.some((m) => sameModel(m.name, s.model));
						const hasEmbed = models.some((m) => sameModel(m.name, s.embeddingModel));
						connection =
							`Connected to Ollama ${version} (${models.length} models).` +
							(hasChat ? "" : ` Chat model "${s.model}" is not installed: run \`ollama pull ${s.model}\`.`) +
							(s.semanticSearch && !hasEmbed ? ` Embedding model "${s.embeddingModel}" is not installed: run \`ollama pull ${s.embeddingModel}\`.` : "");
						if (!hasChat) {
							new Notice(connection, 10000);
							return;
						}
					} catch (err) {
						new Notice(`Connection failed: ${(err as Error).message}`, 10000);
						return;
					}
					// A short generation at the configured context: speed, memory split, advice.
					const working = new Notice(`Measuring ${s.model} at a ${Math.round(s.numCtx / 1024)}k context… (loads the model if needed)`, 0);
					try {
						const measured = await measure(this.plugin.client, s.model, s.numCtx, s.keepAlive);
						working.hide();
						const advice = recommend(measured, models);
						const modal = new TuneModal(this.app, advice, connection);
						modal.open();
						const choice = await modal.result;
						if (!choice) return;
						if (choice.numCtx) s.numCtx = choice.numCtx;
						if (choice.model) s.model = choice.model;
						await this.plugin.saveSettings();
						this.display();
						new Notice(choice.numCtx ? `Context set to ${choice.numCtx}. Test again to confirm it still fits.` : `Chat model set to ${choice.model}.`);
					} catch (err) {
						working.hide();
						new Notice(`${connection}\nSpeed test failed: ${(err as Error).message}`, 10000);
					}
				}),
			);

		const lc = this.plugin.lectureCompanion();
		if (lc) {
			const shared = lc.ollama();
			new Setting(containerEl)
				.setName("Use Lecture Companion's Ollama settings")
				.setDesc(`Lecture Companion is installed and uses ${shared.url} with ${shared.model}. Copy them here so both plugins share one Ollama and one model in memory.`)
				.addButton((b) =>
					b.setButtonText("Use Lecture Companion's Ollama settings").onClick(async () => {
						await this.plugin.useLectureCompanionOllama();
						new Notice(`Now using ${this.plugin.settings.ollamaUrl} with ${this.plugin.settings.model}.`);
						void this.plugin.refreshVision();
						this.display();
					}),
				);
		}

		const modelSetting = new Setting(containerEl)
			.setName("Chat model")
			.setDesc("Must support tool calling. Recommended: qwen3.5:9b (12 GB GPUs), qwen3:14b, llama3.1:8b.");
		modelSetting.addDropdown(async (d) => {
			d.addOption(s.model, s.model);
			d.setValue(s.model);
			try {
				const models = await this.plugin.client.listModels();
				d.selectEl.empty();
				const names = models.filter((m) => !/embed/i.test(m.name)).map((m) => m.name);
				if (!names.some((n) => sameModel(n, s.model))) names.unshift(s.model);
				for (const n of names) d.addOption(n, n);
				d.setValue(s.model);
			} catch {
				// Keep the single current value when Ollama is unreachable.
			}
			d.onChange(async (v) => {
				s.model = v;
				await this.plugin.saveSettings();
				void this.plugin.refreshVision();
			});
		});
		modelSetting.addText((t) =>
			t.setPlaceholder("or type a model name").onChange(async (v) => {
				if (!v.trim()) return;
				s.model = v.trim();
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName("Context window (num_ctx)")
			.setDesc("Tokens the model can see at once. 32768 is the default and the benchmark's setting; 16384 on an 8 GB card. Larger is not faster or more accurate: the conversation the agent carries is capped at the 32k budget regardless, and the KV cache grows with the window (a 96k window for a 9B model is several GB that the embedding model then has to be evicted for, which reloads the chat model on every search).")
			.addText((t) =>
				t.setValue(String(s.numCtx)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (Number.isFinite(n) && n >= 2048 && n <= 262144) {
						s.numCtx = n;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("0.6 is the default. Lower looks more precise but near-greedy decoding makes small models repeat themselves; Qwen's own guidance is 0.6–0.7.")
			.addSlider((sl) =>
				sl.setLimits(0, 1, 0.05).setValue(s.temperature).onChange(async (v) => {
					s.temperature = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Thinking mode")
			.setDesc("For models that support reasoning (Qwen3, DeepSeek-R1). 'Off' (the default) answered as accurately as thinking in the benchmark and two to three times faster. 'Auto' uses the model default.")
			.addDropdown((d) =>
				d
					.addOptions({ auto: "Auto", on: "On", off: "Off" })
					.setValue(s.thinking)
					.onChange(async (v) => {
						s.thinking = v as typeof s.thinking;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show thinking in chat")
			.addToggle((t) =>
				t.setValue(s.showThinking).onChange(async (v) => {
					s.showThinking = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Keep model loaded")
			.setDesc("How long Ollama keeps the model in memory after a request (e.g. 10m, 1h, -1 for forever).")
			.addText((t) =>
				t.setValue(s.keepAlive).onChange(async (v) => {
					s.keepAlive = v.trim() || DEFAULT_SETTINGS.keepAlive;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Vision model")
			.setDesc("Reads images notes embed and scanned PDF pages (the read_image tool), e.g. qwen2.5vl:7b. Empty: the chat model, when it can see (qwen3.5 can). Without one the agent simply is not offered the tool. Readings are cached by the image's content hash.")
			.addText((t) =>
				t.setPlaceholder("(the chat model)").setValue(s.visionModel).onChange(async (v) => {
					s.visionModel = v.trim();
					await this.plugin.saveSettings();
					void this.plugin.refreshVision();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Check").onClick(async () => {
					await this.plugin.refreshVision();
					const model = await this.plugin.vision.model();
					new Notice(model ? `Images will be read with ${model}.` : "No vision model: the chat model cannot see and none is set. Install one, e.g. ollama pull qwen2.5vl:7b.", 8000);
				}),
			);

		new Setting(containerEl).setName("Search").setHeading();

		new Setting(containerEl)
			.setName("Semantic search")
			.setDesc("Embed your notes with a local model so search understands meaning, not just keywords. Keyword search always works as a fallback.")
			.addToggle((t) =>
				t.setValue(s.semanticSearch).onChange(async (v) => {
					s.semanticSearch = v;
					await this.plugin.saveSettings();
					if (v) void this.plugin.index.syncAll();
					else this.plugin.index.cancel();
					this.display();
				}),
			);

		if (s.semanticSearch) {
			new Setting(containerEl)
				.setName("Embedding model")
				.setDesc("Changing this rebuilds the index. nomic-embed-text is small and good.")
				.addText((t) =>
					t.setValue(s.embeddingModel).onChange(async (v) => {
						s.embeddingModel = v.trim() || DEFAULT_SETTINGS.embeddingModel;
						await this.plugin.saveSettings();
					}),
				);

			const status = this.plugin.index.status();
			const statusText = status.building
				? `Indexing… ${status.indexedFiles} notes done, ${status.pending} pending`
				: status.lastError
					? `Error: ${status.lastError}`
					: `${status.indexedFiles} notes indexed (${status.totalChunks} chunks)`;
			new Setting(containerEl)
				.setName("Index")
				.setDesc(statusText)
				.addButton((b) =>
					b.setButtonText("Update").onClick(async () => {
						new Notice("Indexing changed notes…");
						await this.plugin.index.syncAll();
						this.display();
					}),
				)
				.addButton((b) =>
					b.setButtonText("Rebuild").onClick(async () => {
						new Notice("Rebuilding the whole index…");
						await this.plugin.index.syncAll(true);
						this.display();
					}),
				);
		}

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("One folder per line. These are never searched, indexed or edited by the agent.")
			.addTextArea((t) =>
				t.setValue(s.excludedFolders.join("\n")).onChange(async (v) => {
					s.excludedFolders = v.split("\n").map((l) => l.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Note gists")
			.setDesc("Write a one-sentence gist of every note with the chat model (in the background, paused while you chat) and show it in the vault outline the agent sees on every message. Off by default: the benchmark scored the same without it, and the pass runs the chat model once per note, which on a modest GPU is an hour for a large vault. The embedding index is separate and stays on.")
			.addToggle((t) =>
				t.setValue(s.gists).onChange(async (v) => {
					s.gists = v;
					await this.plugin.saveSettings();
					if (v) void this.plugin.gists.syncAll();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Rebuild").onClick(() => {
					const g = this.plugin.gists.status();
					new Notice(`Regenerating gists (${g.done}/${g.total} so far)…`);
					void this.plugin.gists.syncAll(true);
				}),
			);

		new Setting(containerEl).setName("Agent").setHeading();

		new Setting(containerEl)
			.setName("Auto-approve edits")
			.setDesc("Skip the diff approval dialog and let the agent write to notes directly. Not recommended; you can also choose 'Approve all' per chat.")
			.addToggle((t) =>
				t.setValue(s.autoApproveEdits).onChange(async (v) => {
					s.autoApproveEdits = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Keep going when the model asks for permission")
			.setDesc("Small models like to stop with 'Would you like me to proceed?'. When on, the agent answers yes for you (up to three times per message) so multi-note tasks run to the end. Every write still goes through approval.")
			.addToggle((t) =>
				t.setValue(s.autoContinue).onChange(async (v) => {
					s.autoContinue = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Max tool calls per message")
			.setDesc("Stops runaway loops. Multi-note clean-ups need 2–3 calls per note, so keep this generous.")
			.addSlider((sl) =>
				sl.setLimits(3, 150, 1).setValue(s.maxIterations).onChange(async (v) => {
					s.maxIterations = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Max characters per tool result")
			.setDesc("Longer notes are paged. Lower this for small context windows.")
			.addText((t) =>
				t.setValue(String(s.maxToolResultChars)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (Number.isFinite(n) && n >= 1000 && n <= 200000) {
						s.maxToolResultChars = n;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Conventions note")
			.setDesc("A note in your vault that is given to the agent on every message, like a CLAUDE.md: folder meanings, naming rules, things to never touch.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.conventionsNote).setValue(s.conventionsNote).onChange(async (v) => {
					s.conventionsNote = v.trim() || DEFAULT_SETTINGS.conventionsNote;
					await this.plugin.saveSettings();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Create / open").onClick(async () => {
					const existing = this.plugin.vault.resolve(s.conventionsNote);
					let path = existing;
					if (!path) {
						path = normalizePath(/\.md$/i.test(s.conventionsNote) ? s.conventionsNote : `${s.conventionsNote}.md`);
						await this.plugin.vault.create(path, conventionsTemplate());
						new Notice(`Created ${path}. Edit it like any note.`);
					}
					await this.app.workspace.openLinkText(path, "", true);
				}),
			);

		new Setting(containerEl)
			.setName("Daily notes inbox heading")
			.setDesc("For 'Process my daily notes': the section of each daily note where loose captures land, without the #. The command's dialog lets you change it per run.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.dailyInboxHeading).setValue(s.dailyInboxHeading).onChange(async (v) => {
					s.dailyInboxHeading = v.trim() || DEFAULT_SETTINGS.dailyInboxHeading;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Topic notes folder")
			.setDesc("For 'Process my daily notes': where compiled topic notes are created. Empty means the vault root.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.dailyTopicsFolder).setValue(s.dailyTopicsFolder).onChange(async (v) => {
					s.dailyTopicsFolder = v.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Paragraph citations")
			.setDesc("Answers end with links to the exact paragraphs they used. 'Block ids' links by ^id; a paragraph without one gets an id added, shown as one diff per note for you to approve (rejecting falls back to the heading). 'Headings' never writes and links the paragraph's heading.")
			.addDropdown((d) =>
				d
					.addOptions({ blocks: "Block ids (added on approval)", headings: "Headings only (no writes)", off: "Off" })
					.setValue(s.citations)
					.onChange(async (v) => {
						s.citations = v as typeof s.citations;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Extra instructions")
			.setDesc("Appended to the system prompt. Tell the agent about your vault's conventions, preferred tone, note templates, etc.")
			.addTextArea((t) => {
				t.setValue(s.extraSystemPrompt).onChange(async (v) => {
					s.extraSystemPrompt = v;
					await this.plugin.saveSettings();
				});
				t.inputEl.rows = 5;
				t.inputEl.addClass("lva-settings-textarea");
			});

		new Setting(containerEl).setName("Study").setHeading();

		new Setting(containerEl)
			.setName("Concept folders")
			.setDesc("For 'Suggest concept links': folders whose notes are concept or topic notes, one per line. Notes tagged #concept or #topic, or with type: concept, count too.")
			.addTextArea((t) => {
				t.setValue(s.conceptFolders.join("\n")).onChange(async (v) => {
					s.conceptFolders = v.split("\n").map((l) => l.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				});
				t.inputEl.rows = 3;
			});

		new Setting(containerEl)
			.setName("Quiz questions")
			.setDesc("How many questions 'Quiz me' asks by default.")
			.addSlider((sl) =>
				sl
					.setLimits(3, 15, 1)
					.setValue(s.quizQuestions)
					.onChange(async (v) => {
						s.quizQuestions = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Quiz review folder")
			.setDesc("Missed questions go to 'Quiz review - <topic>' here, after you approve the diff.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.quizReviewFolder).setValue(s.quizReviewFolder).onChange(async (v) => {
					s.quizReviewFolder = v.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Lecture Companion")
			.setDesc(
				lc
					? "Installed: the agent lists lectures and reads timestamped transcripts from it directly (list_lectures, lecture_transcript), quizzes draw on its courses, and the chat has a mic button that transcribes through its whisper server."
					: "Not installed. With Lecture Companion the agent reads lectures and transcripts as structured data, quizzes know your courses, and the chat gets voice input (it transcribes through Lecture Companion's whisper server).",
			);

		new Setting(containerEl).setName("Scheduled jobs").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Obsidian has no background service, so a job runs when Obsidian is open at or after its time. A job never writes: what it would change waits until you review it (a notice when you are back, and a badge in the status bar), as ordinary diffs.",
		});

		const timeSetting = (name: string, desc: string, get: () => string, set: (v: string) => void) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) => {
					t.inputEl.type = "time";
					t.setValue(get()).onChange(async (v) => {
						if (!/^\d{1,2}:\d{2}$/.test(v)) return;
						set(v);
						await this.plugin.saveSettings();
					});
				});

		new Setting(containerEl)
			.setName("Nightly: process my daily notes")
			.setDesc("Compiles the last two days' daily inboxes into topic notes, as the command does, and queues the changes for your review.")
			.addToggle((t) =>
				t.setValue(s.nightlyDaily).onChange(async (v) => {
					s.nightlyDaily = v;
					if (v) s.jobRuns.daily = Date.now();
					await this.plugin.saveSettings();
				}),
			);
		timeSetting("Nightly time", "When the nightly job runs (local time).", () => s.nightlyTime, (v) => (s.nightlyTime = v));

		new Setting(containerEl)
			.setName("Weekly digest")
			.setDesc("A note summarising the notes you created or changed that week, with links, queued for your review.")
			.addToggle((t) =>
				t.setValue(s.weeklyDigest).onChange(async (v) => {
					s.weeklyDigest = v;
					if (v) s.jobRuns.digest = Date.now();
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl).setName("Digest day").addDropdown((d) =>
			d
				.addOptions({ "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday" })
				.setValue(String(s.digestDay))
				.onChange(async (v) => {
					s.digestDay = Number(v);
					await this.plugin.saveSettings();
				}),
		);
		timeSetting("Digest time", "When on that day the digest is written (local time).", () => s.digestTime, (v) => (s.digestTime = v));
		new Setting(containerEl)
			.setName("Digest folder")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.digestFolder).setValue(s.digestFolder).onChange(async (v) => {
					s.digestFolder = v.trim();
					await this.plugin.saveSettings();
				}),
			);
		const waiting = this.plugin.pending.size;
		new Setting(containerEl)
			.setName("Waiting for review")
			.setDesc(waiting ? `${waiting} change${waiting === 1 ? "" : "s"} from scheduled jobs.` : "Nothing waiting.")
			.addButton((b) =>
				b
					.setButtonText("Review now")
					.setDisabled(waiting === 0)
					.onClick(() => void this.plugin.reviewPending()),
			);
	}
}
