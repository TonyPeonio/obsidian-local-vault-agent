import { App, Modal } from "obsidian";
import { SEPARATE_ACTION_MS, approvalKey, approvalStep, separateAction, writes, type ApprovalAction, type ApprovalStage, type ApproveAllScope } from "./approval";
import { computeDiff } from "./diff";
import { t } from "./i18n";
import type { ApprovalDecision, ApprovalRequest } from "./types";

/**
 * Shows a line diff of a proposed change and resolves with the user's decision.
 *
 * "Approve all" (when offered) takes two separate actions: the button, or Ctrl/Cmd+Shift+A, only
 * opens a question in the dialog; the grant is the answer to it. No single key grants it.
 */
export class ApprovalModal extends Modal {
	private decision: ApprovalDecision = "reject";
	private resolve!: (d: ApprovalDecision) => void;
	readonly result: Promise<ApprovalDecision>;
	private stage: ApprovalStage = "choose";
	private buttonsEl!: HTMLElement;
	private hintEl!: HTMLElement;
	private approveBtn: HTMLButtonElement | null = null;
	/** When the buttons were last swapped for the other stage's (ms), or null while the dialog still shows the ones it opened with. */
	private swappedAt: number | null = null;

	/**
	 * @param all What "approve all" covers here: the rest of the chat ("chat"), the rest of a batch
	 * of changes ("batch"), or not offered ("none", for a single change such as an undo).
	 */
	constructor(
		app: App,
		private req: ApprovalRequest,
		private all: ApproveAllScope = "none",
	) {
		super(app);
		this.result = new Promise<ApprovalDecision>((res) => (this.resolve = res));
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("lva-approval-modal");
		titleEl.setText(this.req.summary);
		// Why this dialog is here although nothing asked for a change (see UNASKED_WRITE_CAUTION).
		if (this.req.caution) contentEl.createDiv({ cls: "lva-approval-caution", text: this.req.caution, attr: { role: "alert" } });

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

		this.buttonsEl = contentEl.createDiv({ cls: "lva-approval-buttons" });
		this.hintEl = contentEl.createDiv({ cls: "lva-approval-hint" });
		this.renderStage();

		this.scope.register([], "Enter", (e) => {
			// A button the user tabbed to keeps its own Enter behaviour.
			const focused = activeDocument.activeElement;
			if (focused && focused.instanceOf(HTMLButtonElement) && focused !== this.approveBtn) return true;
			e.preventDefault();
			const action = approvalKey(this.stage, { key: "Enter" }, this.all);
			if (action) this.act(action);
			return false;
		});
		// The chord only asks: it opens the question below the diff, with the focus on "Back".
		this.scope.register(["Mod", "Shift"], "a", (e) => {
			e.preventDefault();
			const action = approvalKey(this.stage, { key: "a", mod: true, shift: true }, this.all);
			if (action) this.act(action);
			return false;
		});
	}

	/** The buttons for the stage the dialog is in: the three choices, or the question about approving everything. */
	private renderStage(): void {
		const buttons = this.buttonsEl;
		buttons.empty();
		this.approveBtn = null;
		buttons.toggleClass("lva-approval-confirming", this.stage === "confirm-all");
		if (this.stage === "choose") {
			const reject = buttons.createEl("button", { text: t("approve.reject") });
			reject.addEventListener("click", () => this.act("reject"));
			if (this.all !== "none") {
				const approveAll = buttons.createEl("button", { text: t(this.all === "chat" ? "approve.all" : "approve.allBatch"), cls: "lva-approve-all-btn" });
				approveAll.addEventListener("click", () => this.act("ask-all"));
			}
			const approve = buttons.createEl("button", { text: t("approve.approve"), cls: "mod-cta" });
			approve.addEventListener("click", () => this.act("approve"));
			this.approveBtn = approve;
			approve.focus();
			this.hintEl.setText(t(this.all === "none" ? "approve.hint" : "approve.hint.all"));
			return;
		}
		buttons.createDiv({ cls: "lva-approval-confirm", text: t(this.all === "chat" ? "approve.confirm.chat" : "approve.confirm.batch"), attr: { role: "alert" } });
		const back = buttons.createEl("button", { text: t("approve.confirm.back") });
		back.addEventListener("click", () => this.act("back"));
		const yes = buttons.createEl("button", { text: t("approve.confirm.yes"), cls: "mod-warning lva-approve-all-yes" });
		yes.addEventListener("click", () => this.act("confirm-all"));
		// Greyed for the moment in which a click on it would not count anyway (see `separateAction`).
		yes.disabled = true;
		window.setTimeout(() => (yes.disabled = false), SEPARATE_ACTION_MS);
		// Focus on the way back, so a second Enter never grants it.
		back.focus();
		this.hintEl.setText("");
	}

	private act(action: ApprovalAction): void {
		// The second click of a double-click, landing on a button that has only just appeared there, approves nothing.
		if (writes(action) && !separateAction(this.swappedAt, Date.now())) return;
		const next = approvalStep(this.stage, action, this.all);
		if (next.decision) {
			this.finish(next.decision);
			return;
		}
		if (next.stage !== this.stage) {
			this.stage = next.stage;
			this.swappedAt = Date.now();
			this.renderStage();
		}
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
