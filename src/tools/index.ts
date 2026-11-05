import type {
	ApprovalRequest,
	OllamaToolSpec,
	ToolContext,
	ToolDefinition,
	VaultAccess,
} from "../types";
import { applyTextEdit } from "../diff";

/**
 * The tools the model can call. Each tool returns plain text or JSON for the model; the
 * agent wraps errors so the model can recover instead of the whole run failing.
 */

export class ToolError extends Error {}

function str(args: Record<string, unknown>, key: string, required = true): string {
	const v = args[key];
	if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
		if (required) throw new ToolError(`Missing required argument "${key}".`);
		return "";
	}
	return typeof v === "string" ? v : String(v);
}

function int(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
	const v = args[key];
	const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
	const v = args[key];
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v.toLowerCase() === "true";
	return fallback;
}

/** Normalize a model-supplied path: forward slashes, `.md` extension, no leading slash. */
export function normalizeNotePath(input: string): string {
	let p = input.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	p = p.replace(/^\[\[|\]\]$/g, "");
	if (!/\.md$/i.test(p)) p += ".md";
	// Collapse accidental double slashes and "./".
	p = p.replace(/\/{2,}/g, "/").replace(/^\.\//, "");
	if (p.split("/").some((seg) => seg === "..")) throw new ToolError("Paths may not contain '..'.");
	if (/^\.obsidian\//i.test(p)) throw new ToolError("The .obsidian folder is off limits.");
	return p;
}

function resolveExisting(vault: VaultAccess, input: string): string {
	const resolved = vault.resolve(input);
	if (!resolved) {
		throw new ToolError(
			`No note found for "${input}". Use search_notes or list_notes to find the exact path.`,
		);
	}
	return resolved;
}

function truncate(text: string, max: number, offset = 0): { text: string; truncated: boolean; total: number } {
	const total = text.length;
	const slice = text.slice(offset, offset + max);
	return { text: slice, truncated: offset + max < total, total };
}

async function requestApproval(ctx: ToolContext, req: ApprovalRequest): Promise<void> {
	const decision = await ctx.approve(req);
	if (decision === "reject") {
		throw new ToolError("The user rejected this change. Ask them what they would like instead; do not retry the same edit.");
	}
}

export const searchNotes: ToolDefinition = {
	name: "search_notes",
	description:
		"Search the vault for notes relevant to a query. Combines semantic search (meaning) with keyword search. Returns note paths with a short snippet. Use this first whenever the user asks about something in their notes.",
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "What to look for. A natural-language phrase or keywords." },
			limit: { type: "integer", description: "Maximum results to return (default 8, max 25)." },
		},
		required: ["query"],
	},
	mutates: false,
	async execute(args, ctx) {
		const query = str(args, "query");
		const limit = int(args, "limit", 8, 1, 25);
		const hits = await ctx.search(query, limit);
		if (hits.length === 0) return `No notes matched "${query}". Try different keywords or list_notes.`;
		return JSON.stringify(
			hits.map((h) => ({ path: h.path, heading: h.heading, snippet: h.snippet })),
			null,
			1,
		);
	},
};

export const readNote: ToolDefinition = {
	name: "read_note",
	description:
		"Read the full contents of a note by path (or by exact note name). Also returns its tags, outgoing links, backlinks and headings. Long notes are paged: use `offset` to continue.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Vault-relative path like 'Projects/Chess Robot.md', or the note name." },
			offset: { type: "integer", description: "Character offset to start reading from (default 0)." },
		},
		required: ["path"],
	},
	mutates: false,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const offset = int(args, "offset", 0, 0, 50_000_000);
		const content = await ctx.vault.read(path);
		const meta = ctx.vault.getMetadata(path);
		const page = truncate(content, ctx.maxResultChars, offset);
		const header = [
			`# ${path}`,
			meta.tags.length ? `tags: ${meta.tags.join(", ")}` : null,
			meta.links.length ? `links to: ${meta.links.slice(0, 30).join(", ")}` : null,
			meta.backlinks.length ? `linked from: ${meta.backlinks.slice(0, 30).join(", ")}` : null,
			`length: ${page.total} characters`,
		]
			.filter(Boolean)
			.join("\n");
		let body = page.text;
		if (offset > 0) body = `[…continuing from character ${offset}]\n` + body;
		if (page.truncated) {
			body += `\n\n[TRUNCATED at character ${offset + ctx.maxResultChars} of ${page.total}. Call read_note again with offset=${offset + ctx.maxResultChars} to continue.]`;
		}
		return `${header}\n---\n${body}`;
	},
};

export const listNotes: ToolDefinition = {
	name: "list_notes",
	description:
		"List notes in the vault, optionally filtered by folder, tag or a substring of the name. Returns paths and last-modified dates, newest first. Use it to browse or when search is not finding a note you expect.",
	parameters: {
		type: "object",
		properties: {
			folder: { type: "string", description: "Only notes inside this folder (recursive). Omit for the whole vault." },
			tag: { type: "string", description: "Only notes with this tag (with or without '#')." },
			name_contains: { type: "string", description: "Only notes whose name contains this text (case-insensitive)." },
			sort: { type: "string", description: "Sort order.", enum: ["modified", "created", "name", "path"] },
			limit: { type: "integer", description: "Maximum results (default 50, max 300)." },
		},
	},
	mutates: false,
	async execute(args, ctx) {
		const folder = str(args, "folder", false).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		const tag = str(args, "tag", false).replace(/^#/, "").toLowerCase();
		const nameContains = str(args, "name_contains", false).toLowerCase();
		const sort = str(args, "sort", false) || "modified";
		const limit = int(args, "limit", 50, 1, 300);

		let notes = ctx.vault.listNotes();
		if (folder) {
			const prefix = folder.toLowerCase() + "/";
			notes = notes.filter((n) => n.path.toLowerCase().startsWith(prefix));
		}
		if (nameContains) notes = notes.filter((n) => n.basename.toLowerCase().includes(nameContains));
		if (tag) {
			notes = notes.filter((n) =>
				ctx.vault.getMetadata(n.path).tags.some((t) => {
					const lower = t.replace(/^#/, "").toLowerCase();
					return lower === tag || lower.startsWith(tag + "/");
				}),
			);
		}
		switch (sort) {
			case "name":
				notes.sort((a, b) => a.basename.localeCompare(b.basename));
				break;
			case "path":
				notes.sort((a, b) => a.path.localeCompare(b.path));
				break;
			case "created":
				notes.sort((a, b) => b.ctime - a.ctime);
				break;
			default:
				notes.sort((a, b) => b.mtime - a.mtime);
		}
		const total = notes.length;
		const rows = notes.slice(0, limit).map((n) => `${n.path}  (modified ${isoDate(n.mtime)})`);
		if (rows.length === 0) return "No notes matched those filters.";
		const more = total > limit ? `\n…and ${total - limit} more. Narrow the filter or raise the limit.` : "";
		return `${total} note${total === 1 ? "" : "s"}:\n${rows.join("\n")}${more}`;
	},
};

export const vaultOverview: ToolDefinition = {
	name: "vault_overview",
	description:
		"Get a map of the vault: folders with note counts, total notes and the most used tags. Useful to orient yourself before browsing.",
	parameters: { type: "object", properties: {} },
	mutates: false,
	async execute(_args, ctx) {
		const notes = ctx.vault.listNotes();
		const folders = new Map<string, number>();
		const tags = new Map<string, number>();
		for (const n of notes) {
			const top = n.folder === "" ? "(root)" : n.folder.split("/")[0];
			folders.set(top, (folders.get(top) ?? 0) + 1);
			for (const t of ctx.vault.getMetadata(n.path).tags) tags.set(t, (tags.get(t) ?? 0) + 1);
		}
		const folderRows = Array.from(folders.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([f, c]) => `  ${f}/  (${c})`);
		const tagRows = Array.from(tags.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 40)
			.map(([t, c]) => `${t} (${c})`);
		return [
			`Total notes: ${notes.length}`,
			`Top-level folders:`,
			...folderRows,
			tagRows.length ? `Most used tags: ${tagRows.join(", ")}` : "No tags in use.",
		].join("\n");
	},
};

export const getActiveNote: ToolDefinition = {
	name: "get_active_note",
	description:
		"Return the note the user currently has open in the editor (path and contents), plus any text they have selected. Use this when the user says 'this note', 'the current note' or 'my selection'.",
	parameters: { type: "object", properties: {} },
	mutates: false,
	async execute(_args, ctx) {
		const path = ctx.vault.getActiveNotePath();
		if (!path) return "No note is currently open in the editor.";
		const content = await ctx.vault.read(path);
		const page = truncate(content, ctx.maxResultChars);
		const selection = ctx.vault.getSelection();
		let out = `# ${path}\n---\n${page.text}`;
		if (page.truncated) out += `\n\n[TRUNCATED. Use read_note with offset=${ctx.maxResultChars} to read more.]`;
		if (selection && selection.trim()) out += `\n\n--- SELECTED TEXT ---\n${selection}`;
		return out;
	},
};

export const createNote: ToolDefinition = {
	name: "create_note",
	description:
		"Create a new note. Fails if the note already exists. The user must approve the content before it is written.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Vault-relative path for the new note, e.g. 'Summaries/Chess Research.md'." },
			content: { type: "string", description: "Full markdown content of the note." },
		},
		required: ["path", "content"],
	},
	mutates: true,
	async execute(args, ctx) {
		const path = normalizeNotePath(str(args, "path"));
		const content = str(args, "content");
		if (ctx.vault.exists(path)) {
			throw new ToolError(`"${path}" already exists. Use edit_note, append_to_note or replace_note instead, or choose another path.`);
		}
		await requestApproval(ctx, { tool: "create_note", path, before: "", after: content, summary: `Create ${path}` });
		await ctx.vault.create(path, content);
		return `Created ${path} (${content.length} characters).`;
	},
};

export const editNote: ToolDefinition = {
	name: "edit_note",
	description:
		"Make a targeted edit to a note by replacing an exact passage with new text. old_text must match the note exactly (copy it from read_note) and must be unique unless replace_all is true. Prefer this over replace_note for small changes.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the note to edit." },
			old_text: { type: "string", description: "The exact text to replace." },
			new_text: { type: "string", description: "The replacement text. Use an empty string to delete the passage." },
			replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match (default false)." },
		},
		required: ["path", "old_text", "new_text"],
	},
	mutates: true,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const oldText = str(args, "old_text");
		const newText = typeof args.new_text === "string" ? args.new_text : str(args, "new_text", false);
		const replaceAll = bool(args, "replace_all");
		const before = await ctx.vault.read(path);
		const result = applyTextEdit(before, oldText, newText, replaceAll);
		if (!result.ok) throw new ToolError(result.error);
		if (result.content === before) return "The edit would not change anything; nothing written.";
		await requestApproval(ctx, {
			tool: "edit_note",
			path,
			before,
			after: result.content,
			summary: `Edit ${path} (${result.count} replacement${result.count === 1 ? "" : "s"})`,
		});
		await ctx.vault.modify(path, result.content);
		return `Edited ${path}: ${result.count} replacement${result.count === 1 ? "" : "s"} applied.`;
	},
};

export const appendToNote: ToolDefinition = {
	name: "append_to_note",
	description: "Append markdown to the end of an existing note. The user must approve before it is written.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the note to append to." },
			content: { type: "string", description: "Markdown to append." },
		},
		required: ["path", "content"],
	},
	mutates: true,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const content = str(args, "content");
		const before = await ctx.vault.read(path);
		const sep = before.length === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
		const after = before + sep + content.replace(/\s+$/, "") + "\n";
		await requestApproval(ctx, { tool: "append_to_note", path, before, after, summary: `Append to ${path}` });
		await ctx.vault.modify(path, after);
		return `Appended ${content.length} characters to ${path}.`;
	},
};

export const replaceNote: ToolDefinition = {
	name: "replace_note",
	description:
		"Replace the entire contents of an existing note. Use this for reformatting or rewriting a whole note. Always read_note first. If the note has a YAML frontmatter block keep it unchanged; if it has none, do not add one. The user must approve before it is written.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the note to rewrite." },
			content: { type: "string", description: "The complete new markdown content." },
		},
		required: ["path", "content"],
	},
	mutates: true,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const content = str(args, "content");
		const before = await ctx.vault.read(path);
		if (content === before) return "The new content is identical to the current note; nothing written.";
		// Guard against a model that "rewrites" a long note into a stub.
		if (before.length > 400 && content.length < before.length * 0.3) {
			throw new ToolError(
				`The new content (${content.length} chars) is less than 30% of the current note (${before.length} chars). If you really mean to shorten it this much, say so to the user and ask them to confirm first; otherwise use edit_note for a targeted change.`,
			);
		}
		await requestApproval(ctx, { tool: "replace_note", path, before, after: content, summary: `Rewrite ${path}` });
		await ctx.vault.modify(path, content);
		return `Rewrote ${path} (${before.length} → ${content.length} characters).`;
	},
};

export const ALL_TOOLS: ToolDefinition[] = [
	searchNotes,
	readNote,
	listNotes,
	vaultOverview,
	getActiveNote,
	createNote,
	editNote,
	appendToNote,
	replaceNote,
];

export function toOllamaTools(tools: ToolDefinition[]): OllamaToolSpec[] {
	return tools.map((t) => ({
		type: "function",
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}));
}

function isoDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}
