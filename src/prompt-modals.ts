import { App, Modal, Setting } from "obsidian";
import type { ProcessDailyOptions } from "./prompts";
import type { TuneAdvice } from "./tune";

/** Shows the auto-tune verdict with one-click buttons for what it suggests. */
export class TuneModal extends Modal {
	private resolve!: (choice: { numCtx?: number; model?: string } | null) => void;
	readonly result: Promise<{ numCtx?: number; model?: string } | null>;
	private done = false;

	constructor(
		app: App,
		private advice: TuneAdvice,
		private connection: string,
	) {
		super(app);
		this.result = new Promise((res) => (this.resolve = res));
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("lva-options-modal");
		titleEl.setText("Connection and speed test");
		contentEl.createEl("p", { cls: "lva-modal-help", text: this.connection });
		contentEl.createEl("p", { cls: "lva-tune-headline", text: this.advice.headline });
		const list = contentEl.createEl("ul", { cls: "lva-tune-lines" });
		for (const line of this.advice.lines) list.createEl("li", { text: line });
		const buttons = new Setting(contentEl);
		if (this.advice.suggestedNumCtx) {
			const n = this.advice.suggestedNumCtx;
			buttons.addButton((b) =>
				b
					.setButtonText(`Use a ${Math.round(n / 1024)}k context`)
					.setCta()
					.onClick(() => this.finish({ numCtx: n })),
			);
		}
		if (this.advice.suggestedModel) {
			const name = this.advice.suggestedModel;
			buttons.addButton((b) => b.setButtonText(`Switch to ${name}`).onClick(() => this.finish({ model: name })));
		}
		buttons.addButton((b) => b.setButtonText("Close").onClick(() => this.finish(null)));
	}

	private finish(choice: { numCtx?: number; model?: string } | null): void {
		if (this.done) return;
		this.done = true;
		this.resolve(choice);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(null);
	}
}

/** Options for "Process my daily notes", prefilled from settings and the Daily Notes plugin. */
export class ProcessDailyModal extends Modal {
	private resolve!: (o: ProcessDailyOptions | null) => void;
	readonly result: Promise<ProcessDailyOptions | null>;
	private done = false;
	private opts: ProcessDailyOptions;

	constructor(
		app: App,
		initial: ProcessDailyOptions,
		private today: Date = new Date(),
	) {
		super(app);
		this.opts = { ...initial };
		this.result = new Promise((res) => (this.resolve = res));
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("lva-options-modal");
		titleEl.setText("Process my daily notes");
		contentEl.createEl("p", {
			cls: "lva-modal-help",
			text: "The agent surveys the inbox section of every daily note, compiles the substantial ones into topic notes with links back to the source days, and can replace each compiled inbox with a link. Every write is shown as a diff first.",
		});

		new Setting(contentEl)
			.setName("Daily notes folder")
			.setDesc("Read from the Daily Notes plugin; empty means the vault root.")
			.addText((t) => t.setValue(this.opts.folder).onChange((v) => (this.opts.folder = v.trim())));

		new Setting(contentEl)
			.setName("Inbox heading")
			.setDesc("The section inside each daily note that collects loose captures, without the #.")
			.addText((t) => t.setValue(this.opts.heading).onChange((v) => (this.opts.heading = v.trim() || "Capture")));

		new Setting(contentEl)
			.setName("Topic notes folder")
			.setDesc("Where compiled notes are created; empty means the vault root.")
			.addText((t) => t.setValue(this.opts.destination).onChange((v) => (this.opts.destination = v.trim())));

		new Setting(contentEl)
			.setName("Look back")
			.addDropdown((d) => {
				d.addOption("all", "All daily notes");
				d.addOption("30", "Last 30 days");
				d.addOption("90", "Last 90 days");
				d.addOption("365", "Last year");
				d.setValue("all");
				d.onChange((v) => {
					if (v === "all") delete this.opts.since;
					else {
						const since = new Date(this.today.getTime() - Number(v) * 86_400_000);
						this.opts.since = since.toISOString().slice(0, 10);
					}
				});
			});

		new Setting(contentEl)
			.setName("Move compiled inboxes out of the daily notes")
			.setDesc("Replace each compiled inbox with '- Moved to [[Topic]]'. Off keeps daily notes unchanged.")
			.addToggle((t) => t.setValue(this.opts.move).onChange((v) => (this.opts.move = v)));

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText("Run")
					.setCta()
					.onClick(() => this.finish(this.opts)),
			);
	}

	private finish(o: ProcessDailyOptions | null): void {
		if (this.done) return;
		this.done = true;
		this.resolve(o);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(null);
	}
}

/** One-line instruction for "Edit the selected text". Enter runs, Escape cancels. */
export class InstructionModal extends Modal {
	private resolve!: (s: string | null) => void;
	readonly result: Promise<string | null>;
	private done = false;
	private value = "";

	constructor(
		app: App,
		private preview: string,
	) {
		super(app);
		this.result = new Promise((res) => (this.resolve = res));
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("lva-options-modal");
		titleEl.setText("Edit the selected text");
		const quote = contentEl.createEl("pre", { cls: "lva-modal-preview" });
		quote.setText(this.preview.length > 400 ? this.preview.slice(0, 400) + "…" : this.preview);
		new Setting(contentEl).setName("Instruction").setDesc("What should change? e.g. 'is a markdown table', 'reads as one tight paragraph', 'is in the past tense'.").addText((t) => {
			t.setPlaceholder("make this a bullet list");
			t.onChange((v) => (this.value = v));
			t.inputEl.addClass("lva-modal-input");
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && this.value.trim()) {
					e.preventDefault();
					this.finish(this.value.trim());
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText("Edit")
					.setCta()
					.onClick(() => this.finish(this.value.trim() || null)),
			);
	}

	private finish(s: string | null): void {
		if (this.done) return;
		this.done = true;
		this.resolve(s);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(null);
	}
}
