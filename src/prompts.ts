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
