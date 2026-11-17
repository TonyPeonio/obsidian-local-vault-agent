import { App, Modal } from "obsidian";
import { computeDiff } from "./diff";
import { t } from "./i18n";
import type { ApprovalDecision, ApprovalRequest } from "./types";

/** Shows a line diff of a proposed change and resolves with the user's decision. */
export class ApprovalModal extends Modal {
	private decision: ApprovalDecision = "reject";
	private resolve!: (d: ApprovalDecision) => void;
	readonly result: Promise<ApprovalDecision>;

	constructor(
		app: App,
		private req: ApprovalRequest,
	) {
		super(app);
		this.result = new Promise<ApprovalDecision>((res) => (this.resolve = res));
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("lva-approval-modal");
		titleEl.setText(this.req.summary);

		const diff = computeDiff(this.req.before, this.req.after);
		const meta = contentEl.createDiv({ cls: "lva-approval-meta" });
		meta.createSpan({ text: this.req.path, cls: "lva-approval-path" });
		meta.createSpan({ text: `+${diff.added} −${diff.removed}`, cls: "lva-approval-stats" });

		// The diff is focusable and labelled, so it can be scrolled with the keyboard and is announced as a region.
		const pre = contentEl.createEl("pre", { cls: "lva-diff", attr: { tabindex: "0", role: "region", "aria-label": `${t("approve.diff")}: ${this.req.path}, +${diff.added} −${diff.removed}` } });
		for (const line of diff.lines) {
			const row = pre.createDiv({ cls: `lva-diff-line lva-diff-${line.type}` });
			row.createSpan({ cls: "lva-diff-gutter", text: line.type === "add" ? "+" : line.type === "remove" ? "−" : " ", attr: { "aria-label": line.type === "add" ? "added" : line.type === "remove" ? "removed" : "unchanged" } });
			row.createSpan({ cls: "lva-diff-text", text: line.text });
		}

		const buttons = contentEl.createDiv({ cls: "lva-approval-buttons" });
		const reject = buttons.createEl("button", { text: t("approve.reject") });
		reject.addEventListener("click", () => this.finish("reject"));
		const approveAll = buttons.createEl("button", { text: t("approve.all") });
		approveAll.addEventListener("click", () => this.finish("approve-all"));
		const approve = buttons.createEl("button", { text: t("approve.approve"), cls: "mod-cta" });
		approve.addEventListener("click", () => this.finish("approve"));
		approve.focus();
		contentEl.createDiv({ cls: "lva-approval-hint", text: t("approve.hint") });
		this.scope.register([], "Enter", (e) => {
			// A button the user tabbed to keeps its own Enter behaviour.
			const focused = activeDocument.activeElement;
			if (focused && focused.instanceOf(HTMLButtonElement) && focused !== approve) return true;
			e.preventDefault();
			this.finish("approve");
			return false;
		});
		this.scope.register([], "a", (e) => {
			e.preventDefault();
			this.finish("approve-all");
			return false;
		});
	}

	private finish(decision: ApprovalDecision): void {
		this.decision = decision;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.decision);
	}
}
