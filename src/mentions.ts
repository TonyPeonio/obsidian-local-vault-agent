import type { NoteInfo, VaultAccess } from "./types";

/**
 * Composer helpers: `[[note]]` mentions that attach a note's content to the message (like
 * file mentions in Claude Code), note matching for the `@` picker, and the `/` commands.
 * Pure: no DOM, no Obsidian.
 */

export interface Mention {
	raw: string;
	path: string;
}

const LINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

/** Wikilinks in the user's text that resolve to notes, deduplicated, in order of appearance. */
export function findMentions(text: string, vault: VaultAccess): Mention[] {
	const out: Mention[] = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(LINK)) {
		const path = vault.resolve(m[1].trim());
		if (!path || seen.has(path)) continue;
		seen.add(path);
		out.push({ raw: m[0], path });
	}
	return out;
}

/**
 * Appends the contents of mentioned notes to the message so the model has them without a
 * tool call. `maxTotalChars` bounds the whole attachment block.
 */
export async function attachMentions(text: string, vault: VaultAccess, maxTotalChars: number): Promise<{ message: string; attached: string[] }> {
	const mentions = findMentions(text, vault);
	if (mentions.length === 0) return { message: text, attached: [] };
	let budget = maxTotalChars;
	const parts: string[] = [];
	const attached: string[] = [];
	for (const m of mentions) {
		if (budget <= 200) break;
		const content = await vault.read(m.path);
		const body = content.length > budget ? content.slice(0, budget) + "\n[… truncated; use read_note with an offset for the rest]" : content;
		budget -= body.length;
		parts.push(`--- Attached note: ${m.path} ---\n${body}`);
		attached.push(m.path);
	}
	const message = `${text}\n\n(The user attached the following note${attached.length === 1 ? "" : "s"} to this message. They are already read; do not read them again. If they do not fully answer the question, find the rest in the vault with search_passages or by following their wikilinks before saying it is not recorded.)\n\n${parts.join("\n\n")}`;
	return { message, attached };
}

/** Ranks notes for the `@` picker: name prefix > name substring > path substring; ties by recency. */
export function matchNotes(query: string, notes: NoteInfo[], limit = 8): NoteInfo[] {
	const q = query.trim().toLowerCase();
	const scored = notes
		.map((n) => {
			const name = n.basename.toLowerCase();
			const path = n.path.toLowerCase();
			let score = 0;
			if (!q) score = 1;
			else if (name === q) score = 5;
			else if (name.startsWith(q)) score = 4;
			else if (name.split(/[\s_-]+/).some((w) => w.startsWith(q))) score = 3;
			else if (name.includes(q)) score = 2;
			else if (path.includes(q)) score = 1;
			return { n, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || b.n.mtime - a.n.mtime);
	return scored.slice(0, limit).map((x) => x.n);
}

export interface SlashCommand {
	id: string;
	name: string;
	description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
	{ id: "reformat", name: "/reformat", description: "Reformat the current note into clean markdown (diff-approved)" },
	{ id: "summarize", name: "/summarize", description: "Summarize the current note in the chat" },
	{ id: "edit", name: "/edit", description: "Rewrite the text selected in the open note from a one-line instruction (diff-approved)" },
	{ id: "daily", name: "/daily", description: "Process my daily notes: compile inbox sections into topic notes, leave the timelines" },
	{ id: "garden", name: "/garden", description: "Write a Vault Suggestions note: broken links, full inboxes, unlinked mentions, duplicates, orphans, stubs" },
	{ id: "undo", name: "/undo", description: "Undo the agent's last change" },
	{ id: "undo-all", name: "/undo-all", description: "Undo every change from the agent's last message" },
	{ id: "new", name: "/new", description: "Start a new chat" },
	{ id: "gists", name: "/gists", description: "Rebuild the one-line gists of every note" },
	{ id: "index", name: "/index", description: "Rebuild the semantic index" },
	{ id: "help", name: "/help", description: "What the agent can do and how to use mentions and commands" },
];

export function matchCommands(query: string): SlashCommand[] {
	const q = query.trim().replace(/^\//, "").toLowerCase();
	return SLASH_COMMANDS.filter((c) => c.id.startsWith(q) || c.id.includes(q));
}

/** The command a message like "/undo" or "/reformat please" names, or null. */
export function parseSlash(text: string): SlashCommand | null {
	const m = /^\/(\S+)/.exec(text.trim());
	if (!m) return null;
	return SLASH_COMMANDS.find((c) => c.id === m[1].toLowerCase()) ?? null;
}

export const HELP_TEXT = [
	"**What I can do:** answer questions from your notes (with citations), compile topics into new notes, reformat, edit, move or delete notes and attachments, and clean up across many notes in one go. Every write is shown as a diff for approval and can be undone.",
	"",
	"**Mentions:** type `@` to pick a note; it is attached to your message as `[[Note]]` so I read it without a tool call.",
	"",
	"**Commands:** " + SLASH_COMMANDS.map((c) => `\`${c.name}\``).join(", "),
	"",
	"**Tips:** a conventions note (Settings → Conventions note) is given to me on every message; `Approve all in this chat` in the diff dialog lets a long clean-up run uninterrupted; the footer shows context use.",
].join("\n");
