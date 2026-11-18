import type { ChatMessage, ToolCall } from "./types";

/**
 * Drawing a saved conversation again as it was: how each tool call ended is written onto its tool
 * message when the chat is saved, and read back when the chat is restored. Pure: no Obsidian imports.
 */

/** How one tool call ended, as far as the chat needs it to draw the card again later. */
export interface ToolOutcome {
	/** False when the tool failed, was refused or was skipped. */
	ok: boolean;
	/** Ids (in the change history) of the writes the call made, for the Undo buttons. */
	changes?: number[];
}

/** The tool message that answers call `index` of the assistant message at `at`: results follow in call order. */
function resultOf(messages: ChatMessage[], at: number, index: number): ChatMessage | undefined {
	const call = messages[at].tool_calls?.[index];
	const candidate = messages[at + 1 + index];
	if (!call || candidate?.role !== "tool") return undefined;
	// The results of one step stand directly under it, without a gap. A step that ended early (stopped,
	// or cut short for repeating itself) has fewer results than calls, and the message this many places
	// further down can then be a tool result of a later step: that one answers another call.
	for (let i = at + 1; i < at + 1 + index; i++) if (messages[i].role !== "tool") return undefined;
	// A turn that was stopped half-way has fewer results than calls; never pair a result with another call.
	if (candidate.tool_name !== undefined && candidate.tool_name !== call.function.name) return undefined;
	if (candidate.tool_call_id !== undefined && call.id !== undefined && candidate.tool_call_id !== call.id) return undefined;
	return candidate;
}

/**
 * Writes what the chat saw of each call (failed or not, which changes it made) onto the tool
 * messages, so the saved conversation can be drawn again as it was. A message that already carries
 * an outcome (from an earlier save, or a restored chat) keeps it. Returns how many were updated.
 */
export function recordOutcomes(messages: ChatMessage[], outcomes: { get(call: ToolCall): ToolOutcome | undefined }): number {
	let updated = 0;
	for (let i = 0; i < messages.length; i++) {
		const calls = messages[i].role === "assistant" ? (messages[i].tool_calls ?? []) : [];
		for (let k = 0; k < calls.length; k++) {
			const msg = resultOf(messages, i, k);
			const outcome = outcomes.get(calls[k]);
			if (!msg || !outcome) continue;
			const changes = outcome.changes?.length ? [...outcome.changes] : undefined;
			if (msg.ok === outcome.ok && sameIds(msg.changes, changes)) continue;
			msg.ok = outcome.ok;
			if (changes) msg.changes = changes;
			else delete msg.changes;
			updated++;
		}
	}
	return updated;
}

function sameIds(a: number[] | undefined, b: number[] | undefined): boolean {
	if (!a?.length && !b?.length) return true;
	return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Phrases a tool result starts with when the call did not run or failed; used only for chats saved before outcomes were recorded. */
const FAILED_RESULT = /^(Error: |Not executed: )/;

/** One tool card of a restored conversation. */
export interface RestoredCard {
	call: ToolCall;
	/** The result text, or null when the turn ended before the tool answered. */
	result: string | null;
	state: "ok" | "error" | "unfinished";
	changes: number[];
}

/** The tool cards under the assistant message at `at`, each with the outcome that was saved with it. */
export function restoredCards(messages: ChatMessage[], at: number): RestoredCard[] {
	const calls = messages[at]?.role === "assistant" ? (messages[at].tool_calls ?? []) : [];
	return calls.map((call, k) => {
		const msg = resultOf(messages, at, k);
		if (!msg) return { call, result: null, state: "unfinished" as const, changes: [] };
		const ok = typeof msg.ok === "boolean" ? msg.ok : !FAILED_RESULT.test(msg.content);
		return { call, result: msg.content, state: ok ? ("ok" as const) : ("error" as const), changes: Array.isArray(msg.changes) ? msg.changes.filter((n) => typeof n === "number") : [] };
	});
}
