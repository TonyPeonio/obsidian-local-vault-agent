/** Canned prompts used by commands. Kept here so the e2e script exercises the same text. */

export function hasFrontmatter(content: string): boolean {
	return /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.test(content);
}

export function reformatPrompt(path: string, content: string): string {
	const fm = hasFrontmatter(content)
		? "Keep the YAML frontmatter block at the top exactly as it is."
		: "The note has no YAML frontmatter; do not add one.";
	return [
		`Reformat the note "${path}" into clean, well-structured markdown.`,
		"Read it with get_active_note or read_note, then write the whole tidied note with replace_note.",
		"Rules: keep every piece of content, every wikilink and every tag; fix the heading hierarchy; use '-' for bullet lists; normalise spacing and emphasis; do not add commentary, summaries or new sections that are not in the original.",
		fm,
	].join(" ");
}

export function summarizePrompt(path: string): string {
	return `Read the note "${path}" and give me a concise summary with the key points as bullets.`;
}

export interface ProcessDailyOptions {
	/** Folder of the daily notes, e.g. "Daily" (empty for the vault root). */
	folder: string;
	/** Heading of the inbox section inside each daily note, without '#', e.g. "Capture". */
	heading: string;
	/** Folder the compiled topic notes go to, e.g. "Topics" (empty for the vault root). */
	destination: string;
	/** Replace each compiled inbox with a link to the topic note. */
	move: boolean;
	/** Only daily notes dated on or after this ISO date; undefined for all. */
	since?: string;
}

/**
 * The "Process my daily notes" job: find inbox sections with real content, compile them into
 * topic notes with source links, and (optionally) leave a link behind. Written as numbered
 * steps with the exact tool calls, because a small model given the goal alone reads the
 * daily notes one by one and runs out of steps.
 */
export function processDailyNotesPrompt(o: ProcessDailyOptions): string {
	const folder = o.folder.replace(/^\/+|\/+$/g, "");
	const dest = o.destination.replace(/^\/+|\/+$/g, "");
	const destPrefix = dest ? `${dest}/` : "";
	const heading = o.heading.replace(/^#+\s*/, "").trim();
	const where = folder ? `the "${folder}/" folder` : "the vault root";
	const steps = [
		`Process the inbox sections of my daily notes: compile what is worth keeping into topic notes and leave the daily notes themselves as timelines. Daily notes live in ${where}; the inbox is the "## ${heading}" section of each.${o.since ? ` Only consider daily notes dated on or after ${o.since} (the date is the file name); ignore older ones.` : ""}`,
		`1. Survey every inbox with ONE call: list_sections with heading "${heading}"${folder ? ` and folder "${folder}"` : ""}, limit 400. It lists that section of every daily note with its size and first line. Do not grep, do not read daily notes one by one, do not guess paths.`,
		`2. Substantial inboxes are the ones with 3 or more lines, a list of names or deadlines, or a code block. Empty inboxes and one-liners are not substantial; leave those notes alone entirely. Then read_section (path, "${heading}") for each substantial inbox only, to get its full text.`,
		`3. Group the substantial inboxes by subject. For each subject create ONE note "${destPrefix}<Subject>.md" with create_note (if a note on that subject already exists there, use append_to_note instead): a title heading, the content rewritten as clean markdown that keeps every fact, name, number, date and link, and a final "## Sources" section listing a wikilink to EACH daily note it came from, e.g. [[${folder ? folder + "/" : ""}2026-09-21]]. The Sources section is required in every note you create or extend: a fact without its day is lost. Code blocks go into "${destPrefix}Code snippets.md" grouped by language, each block followed by its source wikilink.`,
		o.move
			? `4. Then take each compiled inbox out of its daily note: call replace_section with the daily note's path, heading "${heading}" and new_text "- Moved to [[${destPrefix}<Subject>]]" (one call per daily note, nothing else in that note changes). replace_section needs no old text, so do not read the daily notes before or after it; a successful result means it is done. Leave inboxes you did not compile untouched.`
			: `4. Leave the daily notes unchanged.`,
		`Do all of it in this turn without asking, then report: which topic notes you created or extended and from which daily notes, and which inboxes you left alone and why.`,
	];
	return steps.join("\n");
}

/**
 * Rewrite a selection in place: the agent must call edit_note with the selection as old_text
 * so the user gets a diff of exactly the passage they selected.
 */
export function editSelectionPrompt(path: string, selection: string, instruction: string): string {
	return [
		`In the note "${path}", rewrite the selected passage below so that it ${instruction.trim().replace(/[.\s]+$/, "")}.`,
		`Call edit_note once with path "${path}", old_text copied exactly from the passage (every character, including line breaks) and new_text the rewritten passage. Keep every wikilink, tag and fact unless the instruction says otherwise; match the surrounding markdown style; do not add commentary or headings. Do not read the whole note unless old_text is not found. Then report in one line what you changed.`,
		"",
		"Selected passage:",
		'"""',
		selection,
		'"""',
	].join("\n");
}

/** Starter contents for the conventions note (AGENT.md); the user edits it like any note. */
export function conventionsTemplate(): string {
	return [
		"# Vault conventions for the agent",
		"",
		"Everything in this note is given to Local Vault Agent on every message, like a CLAUDE.md.",
		"Keep it short and concrete: what the folders mean, how notes are named, what to never touch.",
		"",
		"## Folders",
		"- `Daily/` — one note per day, named `YYYY-MM-DD`.",
		"- `Projects/` — one note per project; status lives under `## Status`.",
		"- `Templates/` — never edit or search.",
		"",
		"## Style",
		"- Headings in sentence case; `-` for bullets; wikilinks for every reference to another note.",
		"- Lecture notes keep one `## YYYY-MM-DD` section per class.",
		"",
		"## Never",
		"- Never add YAML frontmatter to a note that has none.",
		"- Never delete a note that has backlinks without saying so.",
		"",
	].join("\n");
}
