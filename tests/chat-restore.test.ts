import { describe, expect, it } from "vitest";
import { recordOutcomes, restoredCards, type ToolOutcome } from "../src/chat-restore";
import type { ChatMessage, ToolCall } from "../src/types";

const call = (name: string, args: Record<string, unknown> = {}, id?: string): ToolCall => ({ ...(id ? { id } : {}), function: { name, arguments: args } });
const tool = (name: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "tool", content, tool_name: name, ...extra });

/** A turn with a read that worked, an edit that was approved and an edit that failed. */
function turn() {
	const read = call("read_note", { path: "A.md" });
	const edit = call("edit_note", { path: "A.md" });
	const bad = call("edit_note", { path: "Missing.md" });
	const messages: ChatMessage[] = [
		{ role: "user", content: "fix A" },
		{ role: "assistant", content: "", tool_calls: [read, edit, bad] },
		tool("read_note", "# A.md\n---\nalpha"),
		tool("edit_note", "Edited A.md: 1 replacement applied."),
		tool("edit_note", "Error: Note not found: Missing.md"),
		{ role: "assistant", content: "Done; Missing.md does not exist." },
	];
	return { read, edit, bad, messages };
}

describe("restoring a chat", () => {
	it("writes each call's outcome onto its tool message, and reads it back after a save", () => {
		const { read, edit, bad, messages } = turn();
		const outcomes = new Map<ToolCall, ToolOutcome>([
			[read, { ok: true }],
			[edit, { ok: true, changes: [41] }],
			[bad, { ok: false }],
		]);
		expect(recordOutcomes(messages, outcomes)).toBe(3);
		// What chat.json holds, read back in a new session with no memory of the calls.
		const saved = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
		const cards = restoredCards(saved, 1);
		expect(cards.map((c) => c.state)).toEqual(["ok", "ok", "error"]);
		expect(cards.map((c) => c.changes)).toEqual([[], [41], []]);
		expect(cards[2].result).toBe("Error: Note not found: Missing.md");
		// The assistant message without calls has no cards; a user message neither.
		expect(restoredCards(saved, 5)).toEqual([]);
		expect(restoredCards(saved, 0)).toEqual([]);
	});

	it("keeps an outcome already saved when the session knows nothing about the call", () => {
		const { messages } = turn();
		messages[4].ok = false;
		messages[3].ok = true;
		messages[3].changes = [7];
		expect(recordOutcomes(messages, new Map())).toBe(0);
		expect(restoredCards(messages, 1).map((c) => [c.state, c.changes])).toEqual([
			["ok", []],
			["ok", [7]],
			["error", []],
		]);
	});

	it("does not rewrite an unchanged outcome on every save", () => {
		const { read, edit, bad, messages } = turn();
		const outcomes = new Map<ToolCall, ToolOutcome>([
			[read, { ok: true }],
			[edit, { ok: true, changes: [41] }],
			[bad, { ok: false }],
		]);
		recordOutcomes(messages, outcomes);
		expect(recordOutcomes(messages, outcomes)).toBe(0);
		// A second write by the same call (edit_notes over two notes) is added.
		outcomes.set(edit, { ok: true, changes: [41, 42] });
		expect(recordOutcomes(messages, outcomes)).toBe(1);
		expect(messages[3].changes).toEqual([41, 42]);
	});

	it("reads a chat saved before outcomes were recorded: refused and failed calls are not shown as done", () => {
		const { messages } = turn();
		messages.splice(4, 0, tool("edit_note", "Not executed: the user rejected a change earlier in this turn"));
		messages[1].tool_calls!.splice(2, 0, call("edit_note", { path: "B.md" }));
		expect(restoredCards(messages, 1).map((c) => c.state)).toEqual(["ok", "ok", "error", "error"]);
	});

	it("marks the calls of a turn that was stopped half-way as unfinished, never as done", () => {
		const a = call("read_note", { path: "A.md" });
		const b = call("read_note", { path: "B.md" });
		const c = call("grep_vault", { pattern: "x" });
		const messages: ChatMessage[] = [
			{ role: "user", content: "q" },
			{ role: "assistant", content: "", tool_calls: [a, b, c] },
			tool("read_note", "# A.md\n---\nalpha"),
			// Stopped here: the next message is the user's following question.
			{ role: "user", content: "another question" },
			{ role: "assistant", content: "", tool_calls: [call("search_notes", { query: "q" })] },
			tool("search_notes", "No notes matched"),
		];
		const cards = restoredCards(messages, 1);
		expect(cards.map((x) => x.state)).toEqual(["ok", "unfinished", "unfinished"]);
		expect(cards[1].result).toBeNull();
		// And nothing is written onto a message that is not that call's result.
		recordOutcomes(messages, new Map<ToolCall, ToolOutcome>([[b, { ok: false }], [c, { ok: true }]]));
		expect(messages[3].ok).toBeUndefined();
		expect(messages[5].ok).toBeUndefined();
	});

	it("never pairs a result with another call: the tool name and the call id must agree", () => {
		const a = call("read_note", { path: "A.md" }, "call_1");
		const b = call("grep_vault", { pattern: "x" }, "call_2");
		const messages: ChatMessage[] = [
			{ role: "user", content: "q" },
			{ role: "assistant", content: "", tool_calls: [a, b] },
			tool("read_note", "# A.md\n---\nalpha", { tool_call_id: "call_1" }),
			tool("read_note", "# B.md\n---\nbeta", { tool_call_id: "call_9" }),
		];
		expect(restoredCards(messages, 1).map((c) => c.state)).toEqual(["ok", "unfinished"]);
		const wrongId: ChatMessage[] = [messages[0], messages[1], tool("read_note", "x", { tool_call_id: "call_5" })];
		expect(restoredCards(wrongId, 1)[0].state).toBe("unfinished");
	});

	it("ignores change ids that are not numbers (a hand-edited or damaged chat file)", () => {
		const { messages } = turn();
		(messages[3] as unknown as { changes: unknown }).changes = [3, "x", null, 5];
		expect(restoredCards(messages, 1)[1].changes).toEqual([3, 5]);
		(messages[3] as unknown as { changes: unknown }).changes = "nope";
		expect(restoredCards(messages, 1)[1].changes).toEqual([]);
	});
});
