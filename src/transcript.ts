import { AUTO_CONTINUE_TEXT, GROUNDING_PREFIX } from "./agent";
import type { ChatMessage } from "./types";

/**
 * Renders a conversation as markdown for the "Copy conversation" button: user turns, assistant
 * prose, and a one-line trace of each tool call and result so the whole run can be pasted
 * somewhere else (a bug report, another chat) without screenshots.
 */
export function conversationToMarkdown(messages: ChatMessage[]): string {
	const out: string[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			if (m.content === AUTO_CONTINUE_TEXT) out.push("_(auto-continued: the model asked for permission)_");
			else if (m.content.startsWith(GROUNDING_PREFIX)) out.push(`_(${m.content.trim()})_`);
			else out.push(`**You:** ${m.content.trim()}`);
		} else if (m.role === "assistant") {
			const parts: string[] = [];
			if (m.content.trim()) parts.push(m.content.trim());
			for (const call of m.tool_calls ?? []) {
				parts.push(`> tool: ${call.function.name} ${JSON.stringify(call.function.arguments ?? {})}`);
			}
			if (parts.length > 0) out.push(`**Agent:**\n${parts.join("\n")}`);
		} else if (m.role === "tool") {
			const firstLine = m.content.split("\n").find((l) => l.trim().length > 0) ?? "";
			const summary = firstLine.length > 160 ? firstLine.slice(0, 160) + "…" : firstLine;
			const more = m.content.length > firstLine.length ? ` (${m.content.length} chars)` : "";
			out.push(`> ↳ ${m.tool_name ?? "result"}: ${summary}${more}`);
		}
	}
	return out.join("\n\n");
}
