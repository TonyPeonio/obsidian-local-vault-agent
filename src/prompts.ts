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
