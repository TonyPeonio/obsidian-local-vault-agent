import type { VaultAccess } from "./types";

/**
 * A compact map of the whole vault for the system prompt: every note path with its headings
 * and tags, grouped by folder. The content of 200 notes cannot fit a local context window,
 * but their structure can, and it is what lets the model navigate without searching for
 * things it could simply see.
 */
export function buildOutline(vault: VaultAccess, budgetChars: number): string {
	const notes = vault.listNotes().slice().sort((a, b) => a.path.localeCompare(b.path));
	if (notes.length === 0) return "(the vault has no markdown notes)";

	const render = (withHeadings: boolean, limit: number): string => {
		const lines: string[] = [];
		let folder: string | null = null;
		for (const note of notes.slice(0, limit)) {
			if (note.folder !== folder) {
				folder = note.folder;
				lines.push(folder === "" ? "/" : `${folder}/`);
			}
			let line = `  ${note.basename}`;
			if (withHeadings) {
				const meta = vault.getMetadata(note.path);
				const headings = meta.headings
					.map((h) => h.replace(/^#+\s*/, "").trim())
					.filter(Boolean)
					.slice(0, 6)
					.map((h) => (h.length > 40 ? h.slice(0, 39) + "…" : h));
				if (headings.length) line += ` — ${headings.join(" › ")}`;
				if (meta.headings.length > 6) line += ` (+${meta.headings.length - 6})`;
				const tags = meta.tags.slice(0, 4);
				if (tags.length) line += ` ${tags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ")}`;
			}
			lines.push(line);
		}
		if (limit < notes.length) lines.push(`…and ${notes.length - limit} more notes (use list_notes or search_notes).`);
		return lines.join("\n");
	};

	const full = render(true, notes.length);
	if (full.length <= budgetChars) return full;
	const bare = render(false, notes.length);
	if (bare.length <= budgetChars) return bare;
	// Binary search the largest prefix of notes that fits without headings.
	let lo = 0;
	let hi = notes.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (render(false, mid).length <= budgetChars) lo = mid;
		else hi = mid - 1;
	}
	return render(false, Math.max(lo, 1));
}

/** Share of the context window (in characters, ~3.2 per token) spent on the outline. */
export function outlineBudget(numCtx: number): number {
	return Math.floor(numCtx * 3.2 * 0.12);
}
