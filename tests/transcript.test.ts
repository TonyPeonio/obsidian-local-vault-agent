import { describe, expect, it } from "vitest";
import { AUTO_CONTINUE_TEXT } from "../src/agent";
import { conversationToMarkdown } from "../src/transcript";
import type { ChatMessage } from "../src/types";

describe("conversationToMarkdown", () => {
	it("renders user, assistant, tool calls and results", () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "find my notes on gantry" },
			{ role: "assistant", content: "", tool_calls: [{ function: { name: "search_notes", arguments: { query: "gantry" } } }] },
			{ role: "tool", tool_name: "search_notes", content: '[\n {"path": "Projects/Chess Robot.md"}\n]' },
			{ role: "user", content: AUTO_CONTINUE_TEXT },
			{ role: "assistant", content: "It is in [[Projects/Chess Robot]].", thinking: "hidden" },
		];
		const md = conversationToMarkdown(messages);
		expect(md).toContain("**You:** find my notes on gantry");
		expect(md).toContain('> tool: search_notes {"query":"gantry"}');
		expect(md).toContain("> ↳ search_notes: [");
		expect(md).toContain("_(auto-continued");
		expect(md).toContain("**Agent:**\nIt is in [[Projects/Chess Robot]].");
		expect(md).not.toContain("hidden");
	});
	it("is empty for an empty conversation", () => {
		expect(conversationToMarkdown([])).toBe("");
	});
});
