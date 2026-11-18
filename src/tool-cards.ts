import type { ToolCall } from "./types";

/**
 * What a tool card in the chat says: its icon, the sentence for the call ("Searched notes for …")
 * and a few words about the result. Pure: no Obsidian imports, so every tool can be checked to
 * have an icon and a sentence.
 */

/** A Lucide icon name, plus one that every supported Obsidian version has in case the first is newer than it. */
export interface ToolIcon {
	icon: string;
	fallback: string;
}

const READ_FALLBACK = "search";
const WRITE_FALLBACK = "pencil";

const ICONS: Record<string, ToolIcon> = {
	// Finding
	search_notes: { icon: "search", fallback: READ_FALLBACK },
	search_passages: { icon: "text-search", fallback: READ_FALLBACK },
	grep_vault: { icon: "regex", fallback: READ_FALLBACK },
	find_in_note: { icon: "file-search", fallback: READ_FALLBACK },
	list_sections: { icon: "list-tree", fallback: "list" },
	list_notes: { icon: "folder-tree", fallback: "folder" },
	list_files: { icon: "paperclip", fallback: "folder" },
	vault_overview: { icon: "folder-tree", fallback: "folder" },
	// Reading
	read_note: { icon: "file-text", fallback: "file" },
	read_section: { icon: "heading", fallback: "file-text" },
	get_active_note: { icon: "file-text", fallback: "file" },
	read_file: { icon: "file-type", fallback: "file" },
	read_image: { icon: "image", fallback: "file" },
	list_lectures: { icon: "graduation-cap", fallback: "list" },
	lecture_transcript: { icon: "mic", fallback: "file-text" },
	// Writing
	create_note: { icon: "file-plus", fallback: WRITE_FALLBACK },
	edit_note: { icon: "pencil", fallback: WRITE_FALLBACK },
	edit_notes: { icon: "files", fallback: WRITE_FALLBACK },
	append_to_note: { icon: "list-plus", fallback: WRITE_FALLBACK },
	replace_section: { icon: "replace", fallback: WRITE_FALLBACK },
	replace_note: { icon: "file-pen-line", fallback: WRITE_FALLBACK },
	move_note: { icon: "folder-input", fallback: WRITE_FALLBACK },
	delete_file: { icon: "trash-2", fallback: "trash" },
};

/** Tools that write; an unknown tool with one of these verbs in its name gets the pencil, any other the neutral wrench. */
const WRITE_NAME = /^(create|edit|append|replace|move|delete|write|rename|update)_/;

/** The icon for a tool's card. A tool this table does not know is shown as a wrench (or a pencil when its name says it writes), never as a write by default. */
export function iconFor(tool: string): ToolIcon {
	return ICONS[tool] ?? (WRITE_NAME.test(tool) ? { icon: "pencil", fallback: WRITE_FALLBACK } : { icon: "wrench", fallback: "settings" });
}

function short(v: unknown, max = 48): string {
	const s = typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
	const noExt = s.replace(/\.md$/i, "");
	return noExt.length > max ? noExt.slice(0, max) + "…" : noExt;
}

/** "read_image" → "Read image", for a tool that has no sentence of its own. */
function humanName(tool: string): string {
	const words = tool.replace(/_/g, " ").trim();
	return words ? words[0].toUpperCase() + words.slice(1) : "Tool call";
}

/** "Searched “magnet problems”" instead of `search_notes {"query":…}`. */
export function describeCall(call: ToolCall): string {
	const a = call.function.arguments ?? {};
	switch (call.function.name) {
		case "search_notes":
			return `Searched notes for “${short(a.query)}”`;
		case "search_passages":
			return `Searched passages for “${short(a.query)}”`;
		case "read_note":
			return `Read ${short(a.path)}${a.offset ? ` (from ${short(a.offset)})` : ""}`;
		case "read_section":
			return `Read ${short(a.path)} › ${short(a.heading, 30)}`;
		case "find_in_note":
			return `Looked for “${short(a.pattern, 30)}” in ${short(a.path)}`;
		case "grep_vault":
			return `Grepped the vault for “${short(a.pattern, 30)}”${a.folder ? ` in ${short(a.folder)}` : ""}`;
		case "list_sections": {
			const texts = Array.isArray(a.containing) ? a.containing.map((x) => `“${short(x, 20)}”`).join(" / ") : "";
			const where = a.heading ? ` headed “${short(a.heading, 30)}”` : "";
			return texts ? `Checked sections${where} for ${texts}` : `Listed sections${where}${a.folder ? ` in ${short(a.folder)}` : ""}`;
		}
		case "list_notes":
			return `Listed notes${a.folder ? ` in ${short(a.folder)}` : ""}${a.tag ? ` tagged ${short(a.tag)}` : ""}${a.name_contains ? ` matching “${short(a.name_contains)}”` : ""}`;
		case "list_files":
			return `Listed attachments${a.extension ? ` (.${short(a.extension)})` : ""}${a.folder ? ` in ${short(a.folder)}` : ""}`;
		case "vault_overview":
			return "Looked at the vault overview";
		case "get_active_note":
			return "Read the open note";
		case "create_note":
			return `Created ${short(a.path)}`;
		case "edit_note":
			return `Edited ${short(a.path)}`;
		case "edit_notes": {
			const n = Array.isArray(a.edits) ? a.edits.length : 0;
			return `Applied ${n} edit${n === 1 ? "" : "s"} across notes`;
		}
		case "append_to_note":
			return `Appended to ${short(a.path)}`;
		case "replace_section":
			return `Replaced the section ${short(a.path)} › ${short(a.heading, 30)}`;
		case "replace_note":
			return `Rewrote ${short(a.path)}`;
		case "move_note":
			return `Moved ${short(a.path)} → ${short(a.new_path)}`;
		case "delete_file":
			return `Deleted ${short(a.path)}`;
		case "read_file":
			return `Read attachment ${short(a.path)}`;
		case "read_image":
			return `Looked at the image ${short(a.path)}${a.page ? ` (page ${short(a.page)})` : ""}${a.question ? ` for “${short(a.question, 30)}”` : ""}`;
		case "list_lectures": {
			const range = a.since && a.until ? ` from ${short(a.since)} to ${short(a.until)}` : a.since ? ` since ${short(a.since)}` : a.until ? ` until ${short(a.until)}` : "";
			return `Listed lectures${a.course ? ` in ${short(a.course)}` : ""}${range}${a.contains ? ` mentioning “${short(a.contains, 30)}”` : ""}`;
		}
		case "lecture_transcript":
			return a.query ? `Searched the transcript of ${short(a.path)} for “${short(a.query, 30)}”` : `Read the transcript of ${short(a.path)}`;
		default:
			return humanName(call.function.name);
	}
}

/** A few words about what came back, for the card's right-hand side. */
export function describeResult(call: ToolCall, result: string): string {
	switch (call.function.name) {
		case "search_notes": {
			if (result.startsWith("No notes")) return "no results";
			const n = (result.match(/"path":/g) ?? []).length;
			return `${n} result${n === 1 ? "" : "s"}`;
		}
		case "search_passages": {
			const m = /^(\d+) passage/.exec(result);
			return m ? `${m[1]} passage${m[1] === "1" ? "" : "s"}` : result.startsWith("No passages") ? "no results" : "";
		}
		case "list_notes":
		case "list_files": {
			const m = /^(\d+) (note|file)/.exec(result);
			return m ? `${m[1]} ${m[2]}${m[1] === "1" ? "" : "s"}` : "none";
		}
		case "read_note":
		case "read_section":
		case "get_active_note":
		case "read_file": {
			const m = /length: (\d+) characters/.exec(result);
			return m ? `${Math.round(Number(m[1]) / 1000)}k chars` : result.startsWith("(unchanged") ? "unchanged" : "";
		}
		case "find_in_note": {
			const m = /^(\d+) match/.exec(result);
			return m ? `${m[1]} match${m[1] === "1" ? "" : "es"}` : "no match";
		}
		case "grep_vault": {
			const m = /^(\d+) matching lines? in (\d+) note/.exec(result);
			return m ? `${m[1]} lines in ${m[2]} notes` : "no match";
		}
		case "list_sections": {
			const m = /^(\d+) sections?/.exec(result);
			return m ? `${m[1]} section${m[1] === "1" ? "" : "s"}` : "none";
		}
		case "list_lectures": {
			const m = /^(\d+) lectures?/.exec(result);
			return m ? `${m[1]} lecture${m[1] === "1" ? "" : "s"}` : "";
		}
		case "lecture_transcript": {
			if (/has no transcript\.$/.test(result) || /^No paragraph mentions/m.test(result)) return "no match";
			const shown = (result.match(/^\[\d+:\d{2}(?::\d{2})?\] /gm) ?? []).length;
			return shown ? `${shown} paragraph${shown === 1 ? "" : "s"}` : "";
		}
		case "read_image": {
			const body = result.split("\n---\n")[1] ?? "";
			return body ? `${body.length >= 1000 ? `${Math.round(body.length / 1000)}k` : body.length} chars` : "";
		}
		default:
			return result.length > 70 ? result.slice(0, 70) + "…" : result;
	}
}
