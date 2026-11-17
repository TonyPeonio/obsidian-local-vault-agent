import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "./i18n";
import { issueUrl, reportTitle } from "./report";
import { RECOMMENDED, formatProgress, setupComplete, type MachineTier, type SetupStep } from "./setup";

/**
 * "Report a problem": the issue body is built from what the user writes plus redacted diagnostics,
 * shown in full and editable. Nothing leaves the machine until the user clicks Copy or Open on
 * GitHub, which only opens a browser tab with the text filled in.
 */
export class ReportModal extends Modal {
	private description = "";
	private includeChat = false;
	private edited = false;
	private preview!: HTMLTextAreaElement;

	constructor(
		app: App,
		private build: (description: string, includeChat: boolean) => string,
		private lastError: string | undefined,
		initialDescription = "",
	) {
		super(app);
		this.description = initialDescription;
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("lva-options-modal", "lva-report-modal");
		titleEl.setText(t("report.title"));
		contentEl.createEl("p", { cls: "lva-modal-help", text: t("report.help") });
		const what = contentEl.createEl("textarea", { cls: "lva-report-what", attr: { rows: "4", placeholder: t("report.what.placeholder"), "aria-label": t("report.what") } });
		what.value = this.description;
		what.addEventListener("input", () => {
			this.description = what.value;
			this.refresh();
		});
		new Setting(contentEl).setName(t("report.chat")).addToggle((tg) =>
			tg.setValue(false).onChange((v) => {
				this.includeChat = v;
				this.refresh(true);
			}),
		);
		this.preview = contentEl.createEl("textarea", { cls: "lva-report-preview", attr: { rows: "14", "aria-label": t("report.title"), spellcheck: "false" } });
		this.preview.addEventListener("input", () => (this.edited = true));
		this.refresh(true);
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("report.copy")).onClick(() => void this.copy()))
			.addButton((b) =>
				b
					.setButtonText(t("report.open"))
					.setCta()
					.onClick(() => void this.openIssue()),
			);
		window.setTimeout(() => what.focus(), 0);
	}

	/** Rebuilds the preview unless the user has edited it by hand (a toggle of the chat box always rebuilds). */
	private refresh(force = false): void {
		if (this.edited && !force) return;
		this.preview.value = this.build(this.description, this.includeChat);
		this.edited = false;
	}

	private async copy(): Promise<void> {
		await navigator.clipboard.writeText(this.preview.value);
		new Notice(t("report.copied"));
	}

	private async openIssue(): Promise<void> {
		const body = this.preview.value;
		const { url, copyFirst } = issueUrl(reportTitle(this.description, this.lastError), body);
		if (copyFirst) {
			await navigator.clipboard.writeText(body);
			new Notice(t("report.tooLong"), 10000);
		}
		window.open(url);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export interface SetupActions {
	evaluate(tier: MachineTier): Promise<SetupStep[]>;
	pull(model: string, onProgress: (fraction: number | null, status: string) => void): Promise<void>;
	use(model: string, role: "chat" | "embed"): Promise<void>;
	buildIndex(): Promise<void>;
	openSettings(): void;
	trySample(): Promise<void>;
	initialTier: MachineTier;
}

/** The setup checklist: live status of each step with one fix button, and the model recommendation. */
export class SetupModal extends Modal {
	private tier: MachineTier;
	private listEl!: HTMLElement;
	private busy = false;

	constructor(
		app: App,
		private actions: SetupActions,
	) {
		super(app);
		this.tier = actions.initialTier;
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("lva-options-modal", "lva-setup-modal");
		titleEl.setText(t("setup.title"));
		contentEl.createEl("p", { cls: "lva-modal-help", text: t("setup.help") });
		new Setting(contentEl)
			.setName(t("setup.recommend"))
			.addDropdown((d) =>
				d
					.addOptions({
						"24": `${t("setup.rec.24")} → ${RECOMMENDED["24"]}`,
						"12": `${t("setup.rec.12")} → ${RECOMMENDED["12"]}`,
						"8": `${t("setup.rec.8")} → ${RECOMMENDED["8"]}`,
						cpu: `${t("setup.rec.cpu")} → ${RECOMMENDED.cpu}`,
					})
					.setValue(this.tier)
					.onChange((v) => {
						this.tier = v as MachineTier;
						void this.render();
					}),
			);
		this.listEl = contentEl.createDiv({ cls: "lva-setup-list", attr: { role: "list", "aria-live": "polite" } });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("setup.recheck")).onClick(() => void this.render()))
			.addButton((b) => b.setButtonText(t("setup.sample")).onClick(() => void this.actions.trySample().then(() => this.close())));
		void this.render();
	}

	private async render(): Promise<void> {
		this.listEl.empty();
		this.listEl.createDiv({ cls: "lva-setup-checking", text: t("setup.checking") });
		const steps = await this.actions.evaluate(this.tier);
		this.listEl.empty();
		const names: Record<SetupStep["id"], string> = { server: t("setup.server"), chat: t("setup.chat"), embed: t("setup.embed"), index: t("setup.index") };
		for (const step of steps) {
			const row = this.listEl.createDiv({ cls: `lva-setup-step lva-setup-${step.state}`, attr: { role: "listitem" } });
			const icon = step.state === "ok" ? "✓" : step.state === "warn" ? "!" : step.state === "unknown" ? "…" : "✗";
			row.createSpan({ cls: "lva-setup-icon", text: icon, attr: { "aria-hidden": "true" } });
			const text = row.createDiv({ cls: "lva-setup-text" });
			text.createDiv({ cls: "lva-setup-name", text: names[step.id] });
			const detail = text.createDiv({ cls: "lva-setup-detail", text: step.detail });
			row.setAttribute("aria-label", `${names[step.id]}: ${step.state}. ${step.detail}`);
			if (step.fix) {
				const fix = step.fix;
				const label = fix.kind === "pull" ? t("setup.pull", { model: fix.model }) : fix.kind === "use" ? t("setup.useModel", { model: fix.model }) : fix.kind === "index" ? t("setup.buildIndex") : t("setup.openSettings");
				const btn = row.createEl("button", { text: label, cls: step.state === "missing" ? "mod-cta" : "" });
				btn.addEventListener("click", () => void this.runFix(fix, btn, detail));
			}
		}
		if (setupComplete(steps)) this.listEl.createDiv({ cls: "lva-setup-done", text: t("setup.done") });
	}

	private async runFix(fix: NonNullable<SetupStep["fix"]>, btn: HTMLButtonElement, detail: HTMLElement): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		btn.disabled = true;
		try {
			if (fix.kind === "pull") {
				await this.actions.pull(fix.model, (f, status) => detail.setText(t("setup.pulling", { model: fix.model, pct: formatProgress(f, status) })));
				await this.actions.use(fix.model, /embed/i.test(fix.model) ? "embed" : "chat");
			} else if (fix.kind === "use") await this.actions.use(fix.model, fix.role);
			else if (fix.kind === "index") await this.actions.buildIndex();
			else {
				this.actions.openSettings();
				this.close();
				return;
			}
		} catch (err) {
			new Notice((err as Error).message, 10000);
		} finally {
			this.busy = false;
		}
		await this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
