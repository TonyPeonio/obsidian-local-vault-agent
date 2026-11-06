import type {
	ApprovalRequest,
	OllamaToolSpec,
	ToolContext,
	ToolDefinition,
	VaultAccess,
} from "../types";
import { applyTextEdit } from "../diff";
import { hasFrontmatter } from "../prompts";

/**
 * The tools the model can call. Each tool returns plain text or JSON for the model; the
 * agent wraps errors so the model can recover instead of the whole run failing.
 */

export class ToolError extends Error {}

/** Deleted attachments up to this size are kept in memory so the deletion can be undone. */
export const MAX_UNDO_BINARY_BYTES = 100 * 1024 * 1024;

function str(args: Record<string, unknown>, key: string, required = true): string {
	const v = args[key];
	if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
		if (required) throw new ToolError(`Missing required argument "${key}".`);
		return "";
	}
	return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
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

/**
 * Normalize a model-supplied path: forward slashes, `.md` extension, no leading slash.
 * `configDir` is the vault's configuration folder (`Vault.configDir`), which is off limits.
 */
/** Like normalizeNotePath but keeps whatever extension the path has (attachments). */
export function normalizeFilePath(input: string, configDir?: string): string {
	let p = input.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	p = p.replace(/^!?\[\[|\]\]$/g, "").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
	if (p.split("/").some((seg) => seg === "..")) throw new ToolError("Paths may not contain '..'.");
	if (configDir) {
		const cfg = configDir.replace(/^\/+|\/+$/g, "").toLowerCase();
		if (cfg && p.toLowerCase().startsWith(cfg + "/")) throw new ToolError(`The ${configDir} folder is off limits.`);
	}
	return p;
}

export function normalizeNotePath(input: string, configDir?: string): string {
	let p = input.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	p = p.replace(/^\[\[|\]\]$/g, "");
	if (!/\.md$/i.test(p)) p += ".md";
	// Collapse accidental double slashes and "./".
	p = p.replace(/\/{2,}/g, "/").replace(/^\.\//, "");
	if (p.split("/").some((seg) => seg === "..")) throw new ToolError("Paths may not contain '..'.");
	if (configDir) {
		const cfg = configDir.replace(/^\/+|\/+$/g, "").toLowerCase();
		if (cfg && p.toLowerCase().startsWith(cfg + "/")) throw new ToolError(`The ${configDir} folder is off limits.`);
	}
	return p;
}

/** A model that copied an outline line ("Folder/Note.md — heading › heading #tag") still gets the note. */
export function stripOutlineDecoration(input: string): string {
	return input.replace(/\s+(—|›|\|)\s.*$/, "").replace(/\s+#\S.*$/, "").replace(/\s+\(.*\)$/, "").trim();
}

/** Resolve a note or attachment path, tolerating outline decorations. */
export function resolveAny(vault: VaultAccess, input: string): string | null {
	const direct = vault.resolveFile(input) ?? vault.resolve(input);
	if (direct) return direct;
	const stripped = stripOutlineDecoration(input);
	if (stripped && stripped !== input) return vault.resolveFile(stripped) ?? vault.resolve(stripped);
	return null;
}

function resolveExisting(vault: VaultAccess, input: string): string {
	let resolved = vault.resolve(input);
	if (!resolved) {
		const stripped = stripOutlineDecoration(input);
		if (stripped && stripped !== input) resolved = vault.resolve(stripped);
	}
	if (!resolved) {
		throw new ToolError(
			`No note found for "${input}". Use search_notes or list_notes to find the exact path.`,
		);
	}
	return resolved;
}

function hashText(text: string): string {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return (h >>> 0).toString(36);
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

export const searchPassages: ToolDefinition = {
	name: "search_passages",
	description:
		"Semantic search that returns the best-matching sections of notes verbatim (a heading's paragraphs, not a whole note). Usually enough to answer a question directly; cite the note path. Use search_notes instead when you only need to know which notes exist on a topic.",
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "What to look for, phrased like the content you expect (a question or a statement)." },
			limit: { type: "integer", description: "Maximum passages to return (default 6, max 20)." },
		},
		required: ["query"],
	},
	mutates: false,
	async execute(args, ctx) {
		const query = str(args, "query");
		const limit = int(args, "limit", 6, 1, 20);
		const passages = ctx.searchPassages ? await ctx.searchPassages(query, limit) : [];
		if (passages.length === 0) {
			// No index (disabled, still building, or model missing): fall back to keyword hits.
			const hits = await ctx.search(query, limit);
			if (hits.length === 0) return `No passages matched "${query}". Try other words, or list_notes.`;
			const rows = hits.map((h, i) => `--- [${i + 1}] ${h.path}${h.heading ? ` › ${h.heading}` : ""}\n${h.snippet}`);
			return `The semantic index is not available, so these are keyword matches with short snippets (use read_note or read_section for the text):\n${rows.join("\n")}`;
		}
		const maxEach = Math.max(600, Math.floor(ctx.maxResultChars / passages.length));
		const rows = passages.map((p, i) => {
			const text = p.text.length > maxEach ? p.text.slice(0, maxEach) + "\n[… section truncated; read_section for the rest]" : p.text;
			return `--- [${i + 1}] ${p.path}${p.heading ? ` › ${p.heading}` : ""} (score ${p.score.toFixed(2)})\n${text}`;
		});
		return `${passages.length} passage${passages.length === 1 ? "" : "s"}, best first. Each is one section of a note; cite the note path as a wikilink.\n${rows.join("\n")}`;
	},
};

/** The body of one heading in `content`: from the heading line to the next heading of the same or a higher level. */
export function extractSection(content: string, heading: string): { text: string; startLine: number; endLine: number } | null {
	const lines = content.split("\n");
	const want = heading.replace(/^#+\s*/, "").trim().toLowerCase();
	if (!want) return null;
	let inFence = false;
	let start = -1;
	let level = 0;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
		if (inFence) continue;
		const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
		if (!m) continue;
		const text = m[2].trim().toLowerCase();
		if (start < 0) {
			if (text === want || text.startsWith(want)) {
				start = i;
				level = m[1].length;
			}
		} else if (m[1].length <= level) {
			return { text: lines.slice(start, i).join("\n").trimEnd(), startLine: start + 1, endLine: i };
		}
	}
	if (start < 0) return null;
	return { text: lines.slice(start).join("\n").trimEnd(), startLine: start + 1, endLine: lines.length };
}

export const grepVault: ToolDefinition = {
	name: "grep_vault",
	description:
		"Search the text of every note for a literal string (case-insensitive) or a regular expression, like grep. Returns matching lines as `path:line [enclosing heading]: text` grouped by note, optionally with context lines. The right tool for 'every note that contains X', embeds, tags, headings or exact phrases; much cheaper than reading notes. Two greps (e.g. for an embed and for '### Summary') with their headings tell you which sections have both.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Literal text to look for, or a regular expression when regex is true." },
			regex: { type: "boolean", description: "Treat pattern as a JavaScript regular expression (default false)." },
			folder: { type: "string", description: "Only notes inside this folder (recursive)." },
			context: { type: "integer", description: "Lines of context to show after each match (default 0, max 8)." },
			limit: { type: "integer", description: "Maximum matching lines to return (default 60, max 200)." },
		},
		required: ["pattern"],
	},
	mutates: false,
	async execute(args, ctx) {
		const pattern = str(args, "pattern");
		const useRegex = bool(args, "regex");
		const folder = str(args, "folder", false).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
		const context = int(args, "context", 0, 0, 8);
		const limit = int(args, "limit", 60, 1, 200);
		let test: (line: string) => boolean;
		let note = "";
		let re: RegExp | null = null;
		if (useRegex) {
			try {
				re = new RegExp(pattern, "i");
			} catch (err) {
				note = `(The pattern is not a valid regular expression: ${(err as Error).message}. Searched for it as literal text instead.)\n`;
			}
		}
		if (re) {
			const compiled = re;
			test = (line) => compiled.test(line);
		} else {
			const lower = pattern.toLowerCase();
			test = (line) => line.toLowerCase().includes(lower);
		}
		let notes = ctx.vault.listNotes();
		if (folder) notes = notes.filter((n) => n.path.toLowerCase().startsWith(folder + "/"));
		notes.sort((a, b) => a.path.localeCompare(b.path));
		const blocks: string[] = [];
		let shown = 0;
		let total = 0;
		let notesHit = 0;
		for (const n of notes) {
			const lines = (await ctx.vault.read(n.path)).split("\n");
			const rows: string[] = [];
			let heading = "";
			let inFence = false;
			for (let i = 0; i < lines.length; i++) {
				if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
				const h = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
				if (h) heading = `${h[1]} ${h[2].trim()}`;
				if (!test(lines[i])) continue;
				total++;
				if (shown >= limit) continue;
				shown++;
				rows.push(`${n.path}:${i + 1}${heading && !h ? ` [${heading}]` : ""}: ${lines[i]}`);
				for (let j = i + 1; j <= Math.min(lines.length - 1, i + context); j++) rows.push(`${n.path}:${j + 1}- ${lines[j]}`);
			}
			if (rows.length) {
				notesHit++;
				blocks.push(rows.join("\n"));
			}
		}
		if (total === 0) return `${note}No note contains "${pattern}"${folder ? ` under ${folder}/` : ""}.`;
		const more = total > shown ? `\n…${total - shown} more matching lines not shown; narrow with folder or raise the limit.` : "";
		return `${note}${total} matching line${total === 1 ? "" : "s"} in ${notesHit} note${notesHit === 1 ? "" : "s"}:\n${blocks.join("\n--\n")}${more}`;
	},
};

export const readSection: ToolDefinition = {
	name: "read_section",
	description:
		"Read one section of a note: the heading and everything under it up to the next heading of the same or a higher level. Cheaper than read_note for long notes. Heading text is matched case-insensitively; a prefix is enough.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the note." },
			heading: { type: "string", description: "The heading text, e.g. 'Open problems' or '2026-11-05'." },
		},
		required: ["path", "heading"],
	},
	mutates: false,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const heading = str(args, "heading");
		const content = await ctx.vault.read(path);
		const section = extractSection(content, heading);
		if (!section) {
			const available = ctx.vault.getMetadata(path).headings;
			return `No heading matching "${heading}" in ${path}.${available.length ? ` Headings in this note:\n${available.join("\n")}` : " The note has no headings; use read_note."}`;
		}
		const page = truncate(section.text, ctx.maxResultChars);
		let out = `# ${path} (lines ${section.startLine}–${section.endLine})\n---\n${page.text}`;
		if (page.truncated) out += `\n\n[TRUNCATED at ${ctx.maxResultChars} characters of ${page.total}; use read_note with an offset for the rest.]`;
		return out;
	},
};

export const readNote: ToolDefinition = {
	name: "read_note",
	description:
		"Read the full contents of one note by path (or exact note name), with its tags, links, backlinks and headings. Long notes are paged with `offset`. Costs context: to find which notes mention something use grep_vault or search_passages instead; to read one heading use read_section.",
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
		// Re-reading a note already read in this turn only burns context; the first read is still in the conversation.
		const stamp = `${content.length}:${hashText(content)}`;
		if (ctx.readLog) {
			const seen = ctx.readLog.get(path);
			if (seen === stamp && offset === 0 && content.length <= ctx.maxResultChars) {
				return `(unchanged since you read ${path} earlier in this turn; its full text is already above — do not read it again.)`;
			}
			if (offset === 0 && content.length <= ctx.maxResultChars) ctx.readLog.set(path, stamp);
		}
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
			modified_after: { type: "string", description: "Only notes modified on or after this date (YYYY-MM-DD)." },
			modified_before: { type: "string", description: "Only notes modified before this date (YYYY-MM-DD)." },
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
		const after = parseDate(str(args, "modified_after", false));
		const before = parseDate(str(args, "modified_before", false));

		let notes = ctx.vault.listNotes();
		if (after !== null) notes = notes.filter((n) => n.mtime >= after);
		if (before !== null) notes = notes.filter((n) => n.mtime < before);
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
		const path = normalizeNotePath(str(args, "path"), ctx.configDir);
		const content = str(args, "content");
		if (ctx.vault.exists(path)) {
			throw new ToolError(`"${path}" already exists. Use edit_note, append_to_note or replace_note instead, or choose another path.`);
		}
		await requestApproval(ctx, { tool: "create_note", path, before: "", after: content, summary: `Create ${path}` });
		await ctx.vault.create(path, content);
		ctx.recordChange?.({ tool: "create_note", path, before: "", after: content });
		return `Created ${path} (${content.length} characters).`;
	},
};

export const editNote: ToolDefinition = {
	name: "edit_note",
	description:
		"Make a targeted edit to a note by replacing an exact passage with new text. old_text must match the note exactly and be unique unless replace_all is true: use the smallest unique passage (usually one line), not a whole section. Prefer this over replace_note for small changes; use edit_notes for many edits at once.",
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
		if (!result.ok) {
			// A miss usually means the model worked from a search snippet or a paged read.
			// Show it the real lines so the retry is grounded instead of guessed.
			const hint = /not found/.test(result.error) ? nearestLines(before, oldText) : null;
			throw new ToolError(hint ? `${result.error}\n${hint}` : result.error);
		}
		if (result.content === before) return "The edit would not change anything; nothing written.";
		await requestApproval(ctx, {
			tool: "edit_note",
			path,
			before,
			after: result.content,
			summary: `Edit ${path} (${result.count} replacement${result.count === 1 ? "" : "s"})`,
		});
		await ctx.vault.modify(path, result.content);
		ctx.recordChange?.({ tool: "edit_note", path, before, after: result.content });
		return `Edited ${path}: ${result.count} replacement${result.count === 1 ? "" : "s"} applied.`;
	},
};

export const editNotes: ToolDefinition = {
	name: "edit_notes",
	description:
		"Apply many small edits in one call, possibly across many notes; edits to the same note are combined into one approval. Each edit is {path, new_text} plus EITHER old_text (exact unique passage) OR line_contains (text that identifies one line; add heading to limit the search to that section). new_text replaces the passage or the whole line; an empty new_text deletes it. Example: {\"path\":\"School/Lectures.md\",\"heading\":\"2026-09-02\",\"line_contains\":\"![[Recording 20260902\",\"new_text\":\"\"}. Use this for clean-ups found with grep_vault instead of one edit_note call per match. Failed edits are reported individually; the rest still apply.",
	parameters: {
		type: "object",
		properties: {
			edits: {
				type: "array",
				description: "The edits to apply, at most 40.",
				items: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path of the note." },
						old_text: { type: "string", description: "Exact text to replace (copy it from grep_vault / read_section). Omit when using line_contains." },
						line_contains: { type: "string", description: "Text that occurs in exactly one line (of the section, when heading is given); that whole line is replaced." },
						heading: { type: "string", description: "Optional heading text limiting line_contains to one section." },
						new_text: { type: "string", description: "Replacement; empty string deletes the passage or line." },
					},
					required: ["path", "new_text"],
				},
			},
		},
		required: ["edits"],
	},
	mutates: true,
	async execute(args, ctx) {
		const raw = args.edits;
		if (!Array.isArray(raw) || raw.length === 0) throw new ToolError("edits must be a non-empty array of {path, old_text, new_text}.");
		if (raw.length > 40) throw new ToolError("At most 40 edits per call; split the rest into another call.");
		// Group by resolved note, keeping the order of first appearance.
		const groups = new Map<string, { index: number; oldText: string; newText: string; lineContains?: string; heading?: string }[]>();
		const report: string[] = [];
		raw.forEach((e, index) => {
			const item = (e ?? {}) as Record<string, unknown>;
			const pathInput = typeof item.path === "string" ? item.path : "";
			const oldText = typeof item.old_text === "string" ? item.old_text : "";
			const lineContains = typeof item.line_contains === "string" && item.line_contains.trim() ? item.line_contains.trim() : undefined;
			const heading = typeof item.heading === "string" && item.heading.trim() ? item.heading.trim() : undefined;
			const newText = typeof item.new_text === "string" ? item.new_text : "";
			let path: string | null = null;
			try {
				path = pathInput ? resolveExisting(ctx.vault, pathInput) : null;
			} catch (err) {
				report.push(`#${index + 1} ${pathInput}: ${(err as Error).message}`);
				return;
			}
			if (!path) {
				report.push(`#${index + 1}: missing path.`);
				return;
			}
			if (!oldText && !lineContains) {
				report.push(`#${index + 1} ${path}: give old_text or line_contains.`);
				return;
			}
			const list = groups.get(path) ?? [];
			list.push({ index, oldText, newText, lineContains, heading });
			groups.set(path, list);
		});
		let applied = 0;
		for (const [path, edits] of groups) {
			const before = await ctx.vault.read(path);
			let content = before;
			const okIdx: number[] = [];
			for (const e of edits) {
				if (e.lineContains) {
					const r = replaceLine(content, e.lineContains, e.newText, e.heading);
					if (!r.ok) {
						report.push(`#${e.index + 1} ${path}: ${r.error}`);
						continue;
					}
					content = r.content;
					okIdx.push(e.index + 1);
					continue;
				}
				const result = applyTextEdit(content, e.oldText, e.newText, false);
				if (!result.ok) {
					const hint = /not found/.test(result.error) ? nearestLines(content, e.oldText) : "";
					report.push(`#${e.index + 1} ${path}: ${result.error}${hint ? `\n${hint}` : ""}`);
					continue;
				}
				content = result.content;
				okIdx.push(e.index + 1);
			}
			if (content === before) continue;
			try {
				await requestApproval(ctx, {
					tool: "edit_notes",
					path,
					before,
					after: content,
					summary: `Edit ${path} (${okIdx.length} change${okIdx.length === 1 ? "" : "s"})`,
				});
			} catch (err) {
				report.push(`${path}: ${(err as Error).message}`);
				report.push("Stopped: the user rejected a change. Do not retry it; ask what they want instead.");
				break;
			}
			await ctx.vault.modify(path, content);
			ctx.recordChange?.({ tool: "edit_note", path, before, after: content });
			applied += okIdx.length;
			report.push(`${path}: applied edit${okIdx.length === 1 ? "" : "s"} ${okIdx.map((i) => `#${i}`).join(", ")}.`);
		}
		return `${applied} of ${raw.length} edit${raw.length === 1 ? "" : "s"} applied.\n${report.join("\n")}`;
	},
};

/**
 * Replaces the one line containing `needle` (within `heading`'s section when given) with
 * `newText`; an empty replacement removes the line and a blank line that followed it.
 */
export function replaceLine(content: string, needle: string, newText: string, heading?: string): { ok: true; content: string } | { ok: false; error: string } {
	const lines = content.split("\n");
	let from = 0;
	let to = lines.length;
	if (heading) {
		const section = extractSection(content, heading);
		if (!section) return { ok: false, error: `no heading matching "${heading}".` };
		from = section.startLine - 1;
		to = section.endLine;
	}
	const lower = needle.toLowerCase();
	const hits: number[] = [];
	for (let i = from; i < to; i++) if (lines[i].toLowerCase().includes(lower)) hits.push(i);
	if (hits.length === 0) return { ok: false, error: `no line contains "${needle}"${heading ? ` under "${heading}"` : ""}.` };
	if (hits.length > 1) return { ok: false, error: `"${needle}" occurs on ${hits.length} lines${heading ? ` under "${heading}"` : ""} (${hits.map((i) => i + 1).join(", ")}); add heading or use a longer text.` };
	const i = hits[0];
	if (newText === "") {
		const removeBlank = i + 1 < lines.length && lines[i + 1].trim() === "" && (i === 0 || lines[i - 1].trim() === "");
		lines.splice(i, removeBlank ? 2 : 1);
	} else {
		lines.splice(i, 1, ...newText.split("\n"));
	}
	return { ok: true, content: lines.join("\n") };
}

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
		ctx.recordChange?.({ tool: "append_to_note", path, before, after });
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
		// Small models like to open a rewrite with "---" (a stray rule or invented frontmatter).
		if (!hasFrontmatter(before) && /^---[ \t]*\r?\n/.test(content)) {
			throw new ToolError(
				"The note has no YAML frontmatter, but the new content starts with '---'. Resubmit it without that leading line (if the user explicitly asked for frontmatter, add it with edit_note instead).",
			);
		}
		// Guard against a model that "rewrites" a long note into a stub.
		if (before.length > 400 && content.length < before.length * 0.3) {
			throw new ToolError(
				`The new content (${content.length} chars) is less than 30% of the current note (${before.length} chars). If you really mean to shorten it this much, say so to the user and ask them to confirm first; otherwise use edit_note for a targeted change.`,
			);
		}
		await requestApproval(ctx, { tool: "replace_note", path, before, after: content, summary: `Rewrite ${path}` });
		await ctx.vault.modify(path, content);
		ctx.recordChange?.({ tool: "replace_note", path, before, after: content });
		return `Rewrote ${path} (${before.length} → ${content.length} characters).`;
	},
};

export const findInNote: ToolDefinition = {
	name: "find_in_note",
	description:
		"Find the lines of a note that contain a text (case-insensitive) or a regular expression. Returns 1-based line numbers with one line of context. Use it to locate the exact passage for edit_note in a long note instead of reading the whole note, or to check whether a note mentions something.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the note to search." },
			pattern: { type: "string", description: "Text to look for, or a JavaScript regular expression when regex is true." },
			regex: { type: "boolean", description: "Treat pattern as a regular expression (default false)." },
			limit: { type: "integer", description: "Maximum matches to return (default 20, max 100)." },
		},
		required: ["path", "pattern"],
	},
	mutates: false,
	async execute(args, ctx) {
		const path = resolveExisting(ctx.vault, str(args, "path"));
		const pattern = str(args, "pattern");
		const useRegex = bool(args, "regex");
		const limit = int(args, "limit", 20, 1, 100);
		const content = await ctx.vault.read(path);
		const lines = content.split("\n");
		let test: (line: string) => boolean;
		let note = "";
		let re: RegExp | null = null;
		if (useRegex) {
			try {
				re = new RegExp(pattern, "i");
			} catch (err) {
				// Small models mangle escapes in regexes; a literal search is more useful than an error.
				note = `(The pattern is not a valid regular expression: ${(err as Error).message}. Searched for it as literal text instead.)\n`;
			}
		}
		if (re) {
			const compiled = re;
			test = (line) => compiled.test(line);
		} else {
			const lower = pattern.toLowerCase();
			test = (line) => line.toLowerCase().includes(lower);
		}
		const hits: number[] = [];
		for (let i = 0; i < lines.length; i++) if (test(lines[i])) hits.push(i);
		if (hits.length === 0) {
			return `${note}No lines in ${path} contain "${pattern}". The note has ${lines.length} lines (${content.length} characters).`;
		}
		const blocks = hits.slice(0, limit).map((i) => {
			const rows: string[] = [];
			for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) {
				rows.push(`${j === i ? ">" : " "} ${String(j + 1).padStart(4)} | ${lines[j]}`);
			}
			return rows.join("\n");
		});
		const more = hits.length > limit ? `\n…and ${hits.length - limit} more matches.` : "";
		return `${note}${hits.length} match${hits.length === 1 ? "" : "es"} in ${path} (${lines.length} lines). The matching line is marked with ">".\n${blocks.join("\n---\n")}${more}`;
	},
};

export const listFiles: ToolDefinition = {
	name: "list_files",
	description:
		"List the non-markdown files in the vault (attachments: audio and video recordings, images, PDFs, …), optionally filtered by folder, extension or a substring of the name. Newest first. Use it when the user talks about recordings, media or files rather than notes. Attachments cannot be read or edited, only listed and deleted.",
	parameters: {
		type: "object",
		properties: {
			folder: { type: "string", description: "Only files inside this folder (recursive). Omit for the whole vault; use '/' for the vault root only." },
			extension: { type: "string", description: "Only files with this extension, e.g. 'webm', 'm4a', 'pdf' (without the dot)." },
			name_contains: { type: "string", description: "Only files whose name contains this text (case-insensitive)." },
			limit: { type: "integer", description: "Maximum results (default 50, max 300)." },
		},
	},
	mutates: false,
	async execute(args, ctx) {
		const folder = str(args, "folder", false).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		const rootOnly = str(args, "folder", false).trim() === "/";
		const extension = str(args, "extension", false).replace(/^\./, "").toLowerCase();
		const nameContains = str(args, "name_contains", false).toLowerCase();
		const limit = int(args, "limit", 50, 1, 300);

		let files = ctx.vault.listAttachments();
		if (rootOnly) files = files.filter((f) => f.folder === "");
		else if (folder) {
			const prefix = folder.toLowerCase() + "/";
			files = files.filter((f) => f.path.toLowerCase().startsWith(prefix));
		}
		if (extension) files = files.filter((f) => f.extension === extension);
		if (nameContains) files = files.filter((f) => f.basename.toLowerCase().includes(nameContains));
		files.sort((a, b) => b.mtime - a.mtime);
		const total = files.length;
		if (total === 0) return "No attachments matched those filters.";
		const rows = files.slice(0, limit).map((f) => `${f.path}  (${formatSize(f.size)}, modified ${isoDate(f.mtime)})`);
		const more = total > limit ? `\n…and ${total - limit} more. Narrow the filter or raise the limit.` : "";
		return `${total} file${total === 1 ? "" : "s"}:\n${rows.join("\n")}${more}`;
	},
};

export const deleteFile: ToolDefinition = {
	name: "delete_file",
	description:
		"Move a note or any other vault file (an attachment such as a recording, image or PDF) to the trash. Recoverable, never a permanent delete. The user must approve each deletion; if they reject it, do not try again — ask what they want instead.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Vault-relative path of the note or file to delete, e.g. 'Courses/CSCI578/2026-11-05.md' or 'Recordings/lecture.webm'." },
		},
		required: ["path"],
	},
	mutates: true,
	async execute(args, ctx) {
		const input = str(args, "path");
		const path = resolveAny(ctx.vault, input);
		if (!path) throw new ToolError(`No file found for "${input}". Use list_notes or list_files to find the exact path.`);
		const isNote = /\.md$/i.test(path);
		let before: string;
		let binary: ArrayBuffer | undefined;
		if (isNote) before = await ctx.vault.read(path);
		else {
			const info = ctx.vault.listAttachments().find((f) => f.path === path);
			before = `(attachment${info ? `, ${formatSize(info.size)}` : ""})`;
			// Keep a copy for undo unless it is huge.
			if (!info || info.size <= MAX_UNDO_BINARY_BYTES) {
				try {
					binary = await ctx.vault.readBinary(path);
				} catch {
					binary = undefined;
				}
			}
		}
		await requestApproval(ctx, { tool: "delete_file", path, before, after: "", summary: `Delete ${path} (move to trash)` });
		await ctx.vault.trash(path);
		ctx.recordChange?.({ tool: "delete_file", path, before, after: "", binary });
		return `Moved ${path} to the trash.`;
	},
};

export const moveNote: ToolDefinition = {
	name: "move_note",
	description:
		"Move or rename a note (or an attachment) to a new path. Wikilinks to it in other notes are updated automatically; missing folders are created. Use it to organise the vault. The user must approve first.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Current path of the note or file." },
			new_path: { type: "string", description: "New vault-relative path, e.g. 'Archive/2025/Old Project.md'. Keep the extension." },
		},
		required: ["path", "new_path"],
	},
	mutates: true,
	async execute(args, ctx) {
		const input = str(args, "path");
		const path = resolveAny(ctx.vault, input);
		if (!path) throw new ToolError(`No file found for "${input}". Use list_notes or list_files to find the exact path.`);
		const isNote = /\.md$/i.test(path);
		const newPath = isNote ? normalizeNotePath(str(args, "new_path"), ctx.configDir) : normalizeFilePath(str(args, "new_path"), ctx.configDir);
		if (newPath === path) return "The new path is the same as the current one; nothing moved.";
		if (ctx.vault.resolveFile(newPath) || ctx.vault.exists(newPath)) throw new ToolError(`"${newPath}" already exists. Choose another path.`);
		await requestApproval(ctx, { tool: "move_note", path, before: path, after: newPath, summary: `Move ${path} → ${newPath}` });
		await ctx.vault.rename(path, newPath);
		ctx.recordChange?.({ tool: "move_note", path: newPath, before: path, after: newPath });
		return `Moved ${path} to ${newPath}. Links in other notes were updated.`;
	},
};

function formatSize(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} kB`;
	return `${bytes} B`;
}

/**
 * For a failed edit_note: lines containing the most distinctive word of `oldText`, so the
 * model can copy the real text instead of guessing again.
 */
export function nearestLines(content: string, oldText: string): string {
	const lines = content.split("\n");
	const tokens = Array.from(new Set(oldText.split(/[^\p{L}\p{N}_.-]+/u).filter((t) => t.length >= 4))).sort(
		(a, b) => b.length - a.length,
	);
	for (const token of tokens.slice(0, 4)) {
		const lower = token.toLowerCase();
		const hits: number[] = [];
		for (let i = 0; i < lines.length && hits.length < 5; i++) {
			if (lines[i].toLowerCase().includes(lower)) hits.push(i);
		}
		if (hits.length > 0) {
			const rows = hits.map((i) => `${String(i + 1).padStart(4)} | ${lines[i]}`).join("\n");
			return `Lines in the note that contain "${token}" (copy old_text exactly from the note, or call find_in_note for more context):\n${rows}`;
		}
	}
	return `Nothing similar was found. The note has ${lines.length} lines (${content.length} characters); use find_in_note or read_note to locate the passage.`;
}


/** "YYYY-MM-DD" (or any Date-parsable string) → epoch ms at local midnight, or null. */
export function parseDate(s: string): number | null {
	const t = s.trim();
	if (!t) return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
	const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(t);
	const ms = d.getTime();
	return Number.isFinite(ms) ? ms : null;
}

export const readFile: ToolDefinition = {
	name: "read_file",
	description:
		"Read the text of an attachment: a PDF (text is extracted per page) or a plain-text file (.txt, .csv, .json, .html, …). Not for notes — use read_note. Long files are paged with offset.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the attachment, e.g. 'Attachments/slides.pdf'." },
			offset: { type: "integer", description: "Character offset to start from (default 0)." },
		},
		required: ["path"],
	},
	mutates: false,
	async execute(args, ctx) {
		const input = str(args, "path");
		const path = ctx.vault.resolveFile(input);
		if (!path) throw new ToolError(`No file found for "${input}". Use list_files to find the exact path.`);
		if (/\.md$/i.test(path)) throw new ToolError(`${path} is a note; use read_note.`);
		if (!ctx.readAttachmentText) throw new ToolError("Reading attachments is not available here.");
		const offset = int(args, "offset", 0, 0, 50_000_000);
		const text = await ctx.readAttachmentText(path);
		if (!text.trim()) return `${path} contains no extractable text (it may be a scanned image or a binary file).`;
		const page = truncate(text, ctx.maxResultChars, offset);
		let out = `# ${path}\nlength: ${page.total} characters\n---\n${page.text}`;
		if (page.truncated) out += `\n\n[TRUNCATED at character ${offset + ctx.maxResultChars} of ${page.total}. Call read_file again with offset=${offset + ctx.maxResultChars} to continue.]`;
		return out;
	},
};

function isoDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export const ALL_TOOLS: ToolDefinition[] = [
	searchPassages,
	searchNotes,
	readNote,
	readSection,
	findInNote,
	grepVault,
	listNotes,
	listFiles,
	readFile,
	vaultOverview,
	getActiveNote,
	createNote,
	editNote,
	editNotes,
	appendToNote,
	replaceNote,
	moveNote,
	deleteFile,
];

export function toOllamaTools(tools: ToolDefinition[]): OllamaToolSpec[] {
	return tools.map((t) => ({
		type: "function",
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}));
}
