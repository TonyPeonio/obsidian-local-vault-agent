import type { ApprovalDecision } from "./types";

/**
 * The diff dialog's decisions, kept apart from its DOM so the one rule that matters can be tested:
 * blanket approval is never one keypress or one click away. Asking for it only opens a visible
 * confirmation; a second, different action grants it. Pure: no Obsidian imports.
 */

/** "choose": the diff with Approve / Reject. "confirm-all": the question "approve everything from here on?". */
export type ApprovalStage = "choose" | "confirm-all";

/** What the user did in the dialog. */
export type ApprovalAction = "approve" | "reject" | "ask-all" | "confirm-all" | "back";

/** What "approve all" would cover: the rest of this chat, the rest of one batch of changes, or it is not offered. */
export type ApproveAllScope = "chat" | "batch" | "none";

export interface ApprovalStep {
	stage: ApprovalStage;
	/** Set when the dialog closes with this decision. */
	decision?: ApprovalDecision;
}

/** The dialog after `action`: the stage it is in, and the decision when it is over. */
export function approvalStep(stage: ApprovalStage, action: ApprovalAction, scope: ApproveAllScope): ApprovalStep {
	if (action === "reject") return { stage, decision: "reject" };
	if (stage === "choose") {
		if (action === "approve") return { stage, decision: "approve" };
		if (action === "ask-all" && scope !== "none") return { stage: "confirm-all" };
		// "confirm-all" without having been asked is not a grant.
		return { stage };
	}
	if (action === "confirm-all" && scope !== "none") return { stage, decision: "approve-all" };
	if (action === "back") return { stage: "choose" };
	// Enter ("approve") while the question is open approves nothing: the user answers the question first.
	return { stage };
}

export interface KeyPress {
	key: string;
	/** Ctrl on Windows and Linux, Cmd on macOS. */
	mod?: boolean;
	shift?: boolean;
	alt?: boolean;
}

/**
 * The action a key stands for in the dialog, or null. Enter approves the one change shown; the
 * only way to blanket approval from the keyboard is the chord Mod+Shift+A, and that only asks.
 * A bare letter does nothing. (Esc closes the dialog, which rejects; buttons reached with Tab
 * keep their own Enter.)
 */
export function approvalKey(stage: ApprovalStage, press: KeyPress, scope: ApproveAllScope): ApprovalAction | null {
	if (stage !== "choose") return null;
	const plain = !press.mod && !press.shift && !press.alt;
	if (press.key === "Enter" && plain) return "approve";
	if (press.key.toLowerCase() === "a" && press.mod && press.shift && !press.alt && scope !== "none") return "ask-all";
	return null;
}

/** Why changes are being written without a diff right now, for the chat's indicator: this chat's "approve all", the global setting, or neither. */
export function unattendedWrites(chatApproveAll: boolean, autoApproveSetting: boolean): "chat" | "setting" | null {
	if (chatApproveAll) return "chat";
	return autoApproveSetting ? "setting" : null;
}
