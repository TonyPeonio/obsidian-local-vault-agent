import { chunkMarkdown } from "./chunker";
import { lexQueryTerms, lexTokens } from "./retrieval";
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

/**
 * How everything the composer adds to a message begins (the attached notes here, the attached
 * pictures in composer-images.ts). What the user typed ends where this first appears: after it
 * comes the text of notes and pictures, which is material and never the user's request (see
 * `ownWords` in agent.ts).
 */
export const ATTACHED_OPENING = "\n\n(The user attached";

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
	// What the question asks for and the attached notes do not say is often one link away ("the
	// net is described in [[NNUE Training]]"): bring those passages along.
	const linked = await linkedPassages(text, attached, vault, Math.min(budget, LINKED_BUDGET));
	for (const p of linked) parts.push(`--- From ${p.path}${p.crumb ? ` › ${p.crumb}` : ""}, which the attached note links to ---\n${p.text}`);
	const message = `${text}${ATTACHED_OPENING} the following note${attached.length === 1 ? "" : "s"} to this message. They are already read; do not read them again. If they do not fully answer the question, find the rest in the vault with search_passages or by following their wikilinks before saying it is not recorded.)\n\n${parts.join("\n\n")}`;
	return { message, attached };
}

/** Characters of passages from linked notes that may ride along with attached notes. */
const LINKED_BUDGET = 2400;
/** Linked notes looked at, most at a time. */
const LINKED_NOTES = 20;

/**
 * Passages from the notes the attached notes link to (one hop) that contain words of the question
 * the attached notes themselves do not. No model and no index: the linked notes are read and
 * matched by their words. Nothing comes back when the attached notes already have every word of
 * the question (a request to summarise or reformat the note is left alone), or when no linked
 * note has the missing ones.
 */
export async function linkedPassages(question: string, attached: string[], vault: VaultAccess, budget: number): Promise<{ path: string; crumb: string; text: string }[]> {
	if (attached.length === 0 || budget < 300) return [];
	const asked = lexQueryTerms(question.replace(LINK, " ")).filter((t) => t.length >= 3);
	if (asked.length === 0) return [];
	const have = new Set<string>();
	const targets: string[] = [];
	for (const path of attached) {
		for (const t of lexTokens(await vault.read(path))) have.add(t);
		for (const link of vault.getMetadata(path).links) {
			const to = vault.resolve(link);
			if (to && !attached.includes(to) && !targets.includes(to)) targets.push(to);
		}
	}
	const missing = asked.filter((t) => !have.has(t));
	if (missing.length === 0 || targets.length === 0) return [];
	const found: { path: string; crumb: string; text: string; score: number }[] = [];
	for (const path of targets.slice(0, LINKED_NOTES)) {
		let content: string;
		try {
			content = await vault.read(path);
		} catch {
			continue; // an excluded or vanished note
		}
		for (const chunk of chunkMarkdown(content)) {
			const words = new Set(lexTokens(`${chunk.crumb} ${chunk.text}`));
			const hit = missing.filter((t) => words.has(t)).length;
			// The words the question shares with the attached note break ties: the passage is about the same thing.
			if (hit > 0) found.push({ path, crumb: chunk.crumb, text: chunk.text, score: hit * 10 + asked.filter((t) => words.has(t)).length });
		}
	}
	found.sort((a, b) => b.score - a.score);
	const out: { path: string; crumb: string; text: string }[] = [];
	let left = budget;
	for (const f of found.slice(0, 3)) {
		const text = f.text.length > 800 ? `${f.text.slice(0, 800)}\n[… read_section for the rest]` : f.text;
		if (text.length > left) break;
		left -= text.length;
		out.push({ path: f.path, crumb: f.crumb, text });
	}
	return out;
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
	{ id: "garden", name: "/garden", description: "Suggest vault improvements in the chat: broken links, full inboxes, unlinked mentions, duplicates, orphans, stubs (writes nothing)" },
	{ id: "quiz", name: "/quiz", description: "Quiz me on a topic or course since a date; missed questions go to a review note (or type: quiz me on … since …)" },
	{ id: "concepts", name: "/concepts", description: "Suggest concept links for the open note: link the concept notes it mentions, optionally as parent/child properties" },
	{ id: "history", name: "/history", description: "Change history: every approved change, with its diff and Undo" },
	{ id: "review", name: "/review", description: "Review the changes scheduled jobs queued (nightly daily notes, weekly digest)" },
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
