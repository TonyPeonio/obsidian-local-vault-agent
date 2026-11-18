import { describe, expect, it } from "vitest";
import { SEPARATE_ACTION_MS, approvalKey, approvalStep, separateAction, unattendedWrites, writes, type ApprovalAction, type ApprovalStage, type ApproveAllScope, type KeyPress } from "../src/approval";

const ACTIONS: ApprovalAction[] = ["approve", "reject", "ask-all", "confirm-all", "back"];
const SCOPES: ApproveAllScope[] = ["chat", "batch", "none"];

/** Every key a hand can land on by accident, bare and with each modifier. */
function everyKeyPress(): KeyPress[] {
	const keys = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "Enter", " ", "Tab", "Backspace", "ArrowDown", "F1"];
	const out: KeyPress[] = [];
	for (const key of keys) for (const mod of [false, true]) for (const shift of [false, true]) for (const alt of [false, true]) out.push({ key, mod, shift, alt });
	return out;
}

describe("the diff dialog's decisions", () => {
	it("never grants approve-all from one action, whatever it is", () => {
		for (const scope of SCOPES) {
			for (const action of ACTIONS) expect(approvalStep("choose", action, scope).decision, `${scope}/${action}`).not.toBe("approve-all");
		}
	});

	it("never grants approve-all from one keypress, with or without modifiers", () => {
		for (const scope of SCOPES) {
			for (const press of everyKeyPress()) {
				const action = approvalKey("choose", press, scope);
				if (!action) continue;
				expect(approvalStep("choose", action, scope).decision, JSON.stringify(press)).not.toBe("approve-all");
			}
		}
	});

	it("does nothing on a bare A, which used to grant it", () => {
		for (const scope of SCOPES) {
			expect(approvalKey("choose", { key: "a" }, scope)).toBeNull();
			expect(approvalKey("choose", { key: "A", shift: true }, scope)).toBeNull();
			expect(approvalKey("choose", { key: "a", mod: true }, scope)).toBeNull();
		}
	});

	it("asks first: the button or Mod+Shift+A opens the question, and only its answer grants", () => {
		expect(approvalKey("choose", { key: "A", mod: true, shift: true }, "chat")).toBe("ask-all");
		const asked = approvalStep("choose", "ask-all", "chat");
		expect(asked).toEqual({ stage: "confirm-all" });
		expect(approvalStep(asked.stage, "confirm-all", "chat")).toEqual({ stage: "confirm-all", decision: "approve-all" });
		expect(approvalStep(asked.stage, "back", "chat")).toEqual({ stage: "choose" });
		expect(approvalStep("confirm-all", "confirm-all", "batch").decision).toBe("approve-all");
	});

	it("has no key that answers the question: Enter and the chord do nothing while it is open", () => {
		for (const scope of SCOPES) for (const press of everyKeyPress()) expect(approvalKey("confirm-all", press, scope)).toBeNull();
		// And an "approve" that arrives anyway (a click that raced the redraw) approves nothing.
		expect(approvalStep("confirm-all", "approve", "chat")).toEqual({ stage: "confirm-all" });
	});

	it("does not offer approve-all where it means nothing (an undo, a single change)", () => {
		expect(approvalKey("choose", { key: "a", mod: true, shift: true }, "none")).toBeNull();
		expect(approvalStep("choose", "ask-all", "none")).toEqual({ stage: "choose" });
		// Even from the confirmation stage, which the dialog never reaches with this scope.
		for (const stage of ["choose", "confirm-all"] as ApprovalStage[]) for (const action of ACTIONS) expect(approvalStep(stage, action, "none").decision).not.toBe("approve-all");
	});

	it("keeps the ordinary decisions: Enter approves the one change, reject rejects from either stage", () => {
		expect(approvalKey("choose", { key: "Enter" }, "chat")).toBe("approve");
		expect(approvalKey("choose", { key: "Enter", shift: true }, "chat")).toBeNull();
		expect(approvalStep("choose", "approve", "chat").decision).toBe("approve");
		expect(approvalStep("choose", "reject", "chat").decision).toBe("reject");
		expect(approvalStep("confirm-all", "reject", "chat").decision).toBe("reject");
	});
});

describe("a double-click on the dialog", () => {
	it("does not count its second click as an answer: a button that has only just appeared writes nothing", () => {
		const asked = 10_000;
		// The second click of a double-click on "Approve all…" lands on "Yes, approve all" a moment later.
		expect(separateAction(asked, asked)).toBe(false);
		expect(separateAction(asked, asked + 150)).toBe(false);
		expect(separateAction(asked, asked + SEPARATE_ACTION_MS - 1)).toBe(false);
		// A click after the user has had time to see the question is their answer.
		expect(separateAction(asked, asked + SEPARATE_ACTION_MS)).toBe(true);
		expect(separateAction(asked, asked + 5000)).toBe(true);
		// No shorter than a double-click can be (500 ms is the usual upper limit of one).
		expect(SEPARATE_ACTION_MS).toBeGreaterThanOrEqual(500);
	});

	it("holds back only what writes, and nothing when the dialog has just opened", () => {
		expect(ACTIONS.filter(writes)).toEqual(["approve", "confirm-all"]);
		// Reject, back and asking are always taken; Enter on a freshly opened dialog approves at once, as before.
		expect(separateAction(null, 0)).toBe(true);
	});
});

describe("the chat's 'written without a diff' bar", () => {
	it("is shown for this chat's approve-all, for the global setting, and otherwise not", () => {
		expect(unattendedWrites(false, false)).toBeNull();
		expect(unattendedWrites(true, false)).toBe("chat");
		expect(unattendedWrites(false, true)).toBe("setting");
		expect(unattendedWrites(true, true)).toBe("chat");
	});
});
