import { App, Modal, Setting } from "obsidian";
import type { ConceptProperty, ConceptSuggestion } from "./concepts";
import { computeDiff } from "./diff";
import type { ChangeRecord } from "./types";
import { describeChange } from "./undo";

/** "Quiz me": topic (course), since when, how many questions. */
export class QuizModal extends Modal {
	private resolve!: (o: { topic: string; since: string; count: number } | null) => void;
	readonly result: Promise<{ topic: string; since: string; count: number } | null>;
	private done = false;
	private topic = "";
	private since = "";

	constructor(
		app: App,
		private courses: string[],
		private count: number,
	) {
		super(app);
		this.result = new Promise((res) => (this.resolve = res));
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("lva-options-modal");
		titleEl.setText("Quiz me");
		contentEl.createEl("p", {
			cls: "lva-modal-help",
			text: "Questions are written from your notes on the topic, asked one at a time in the chat and graded against the passage they came from. Missed ones go to a review note, after you approve the diff. Type stop to end early.",
		});
		new Setting(contentEl)
			.setName("Topic or course")
			.setDesc(this.courses.length ? `Lecture Companion courses: ${this.courses.join(", ")}` : "A course folder, a topic, or words from note names.")
			.addText((t) => {
				t.setPlaceholder(this.courses[0] ?? "Machine Learning").onChange((v) => (this.topic = v));
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") this.finish(true);
				});
				window.setTimeout(() => t.inputEl.focus(), 0);
			});
		new Setting(contentEl)
			.setName("Since")
			.setDesc("A date (2026-10-01), or words: last week, 2 weeks ago, monday, Oct 3. Empty for all.")
			.addText((t) => t.setPlaceholder("last week").onChange((v) => (this.since = v)));
		new Setting(contentEl).setName("Questions").addSlider((s) =>
			s
				.setLimits(3, 15, 1)
				.setValue(this.count)
				.onChange((v) => (this.count = v)),
		);
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)))
			.addButton((b) =>
				b
					.setButtonText("Start the quiz")
					.setCta()
					.onClick(() => this.finish(true)),
			);
	}

	private finish(ok: boolean): void {
		if (this.done) return;
		this.done = true;
		this.resolve(ok ? { topic: this.topic.trim(), since: this.since.trim(), count: this.count } : null);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(false);
	}
}

/** Pick which concept links to add, and whether to record them as parent/child properties. */
export class ConceptModal extends Modal {
	private resolve!: (o: { chosen: ConceptSuggestion[]; property: ConceptProperty } | null) => void;
	readonly result: Promise<{ chosen: ConceptSuggestion[]; property: ConceptProperty } | null>;
	private done = false;
	private picked: Set<ConceptSuggestion>;
	private property: ConceptProperty = "none";

	constructor(
		app: App,
		private notePath: string,
		private suggestions: ConceptSuggestion[],
	) {
		super(app);
		this.picked = new Set(suggestions.filter((s) => s.kind === "mentioned"));
		this.result = new Promise((res) => (this.resolve = res));
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("lva-options-modal");
		titleEl.setText("Concept links");
		contentEl.createEl("p", {
			cls: "lva-modal-help",
			text: `Concept notes ${this.notePath.replace(/\.md$/i, "")} talks about. Mentions are linked where they first appear; related notes go under "## Related concepts". You see the whole change as a diff before anything is written.`,
		});
		for (const s of this.suggestions) {
			const name = s.path.replace(/\.md$/i, "");
			const desc = s.kind === "mentioned" ? `Mentioned as “${s.mention?.text ?? ""}”` : `Related by meaning (${Math.round((s.score ?? 0) * 100)}%), not mentioned`;
			new Setting(contentEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(this.picked.has(s)).onChange((v) => {
						if (v) this.picked.add(s);
						else this.picked.delete(s);
					}),
				);
		}
		new Setting(contentEl)
			.setName("Link properties")
			.setDesc("Also record the concepts in this note's frontmatter, as Branching Table of Contents reads them. 'parent': this note sits under each concept, so a concept gathers its lectures from every course.")
			.addDropdown((d) =>
				d
					.addOptions({ none: "Don't add properties", parent: "parent: the concepts", child: "child: the concepts" })
					.setValue(this.property)
					.onChange((v) => (this.property = v as ConceptProperty)),
			);
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)))
			.addButton((b) =>
				b
					.setButtonText("Show the diff")
					.setCta()
					.onClick(() => this.finish(true)),
			);
	}

	private finish(ok: boolean): void {
		if (this.done) return;
		this.done = true;
		const chosen = this.suggestions.filter((s) => this.picked.has(s));
		this.resolve(ok && chosen.length ? { chosen, property: this.property } : null);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(false);
	}
}

function when(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Every approved change, newest first, with its diff and an Undo button. */
export class HistoryModal extends Modal {
	constructor(
		app: App,
		private changes: () => readonly ChangeRecord[],
		private undo: (c: ChangeRecord) => Promise<boolean>,
		private openNote: (path: string) => void,
		private onChange: (listener: () => void) => () => void,
	) {
		super(app);
	}

	private off: (() => void) | null = null;

	onOpen(): void {
		this.modalEl.addClass("lva-history-modal");
		this.titleEl.setText("Change history");
		this.render();
		this.off = this.onChange(() => this.render());
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const list = [...this.changes()].reverse();
		if (list.length === 0) {
			contentEl.createEl("p", { cls: "lva-modal-help", text: "No changes yet. Every diff you approve is listed here, newest first, with an Undo button." });
			return;
		}
		contentEl.createEl("p", { cls: "lva-modal-help", text: `${list.length} approved change${list.length === 1 ? "" : "s"}, newest first (the last 300 are kept). Undo shows the reverse diff for approval and refuses when the note changed since where the change was.` });
		for (const c of list) {
			const row = contentEl.createDiv({ cls: `lva-history-row${c.undone ? " lva-history-undone" : ""}` });
			const head = row.createDiv({ cls: "lva-history-head" });
			head.createSpan({ cls: "lva-history-time", text: when(c.time) });
			head.createSpan({ cls: "lva-history-what", text: c.summary ?? describeChange(c) });
			const src = c.chat === "scheduled" ? "scheduled job" : c.chat === "plugin" ? "vault suggestions" : "chat";
			head.createSpan({ cls: "lva-history-src", text: c.undone ? `${src} · undone ${when(c.undone)}` : src });
			const buttons = head.createDiv({ cls: "lva-history-buttons" });
			if (c.tool !== "move_note" && /\.md$/i.test(c.path)) {
				const openBtn = buttons.createEl("button", { text: "Open" });
				openBtn.addEventListener("click", () => this.openNote(c.path));
			}
			const diffBtn = buttons.createEl("button", { text: "Diff" });
			const undoBtn = buttons.createEl("button", { text: c.undone ? "Undone" : "Undo", cls: c.undone ? "" : "mod-warning" });
			undoBtn.disabled = !!c.undone;
			undoBtn.addEventListener("click", () => {
				undoBtn.disabled = true;
				void this.undo(c).then((ok) => {
					if (!ok) undoBtn.disabled = false;
				});
			});
			let shown: HTMLElement | null = null;
			diffBtn.addEventListener("click", () => {
				if (shown) {
					shown.remove();
					shown = null;
					return;
				}
				shown = row.createEl("pre", { cls: "lva-diff" });
				const diff = c.tool === "move_note" ? null : computeDiff(c.before, c.after);
				if (!diff) {
					shown.createDiv({ text: `${c.before} → ${c.after}` });
					return;
				}
				for (const line of diff.lines) {
					const r = shown.createDiv({ cls: `lva-diff-line lva-diff-${line.type}` });
					r.createSpan({ cls: "lva-diff-gutter", text: line.type === "add" ? "+" : line.type === "remove" ? "−" : " " });
					r.createSpan({ cls: "lva-diff-text", text: line.text });
				}
			});
		}
	}

	onClose(): void {
		this.off?.();
		this.contentEl.empty();
	}
}
