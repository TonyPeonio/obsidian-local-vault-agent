import type { VaultAccess } from "./types";

/**
 * A compact map of the whole vault for the system prompt: every note path, grouped by
 * folder, with a one-line gist when one is cached (otherwise its headings) and its tags.
 * The content of 200 notes cannot fit a local context window, but a line per note can, and
 * it is what lets the model navigate without searching for things it could simply see.
 */

export interface OutlineOptions {
	budgetChars: number;
	/** Cached one-line gist for a note, if any. */
	gist?: (path: string) => string | undefined;
}

type Detail = "gists" | "headings" | "none";

export function buildOutline(vault: VaultAccess, opts: OutlineOptions | number): string {
	const { budgetChars, gist } = typeof opts === "number" ? { budgetChars: opts, gist: undefined } : opts;
	const notes = vault.listNotes().slice().sort((a, b) => a.path.localeCompare(b.path));
	if (notes.length === 0) return "(the vault has no markdown notes)";
	// When gists are rationed, the most recently modified notes get them first.
	const byRecency = notes.slice().sort((a, b) => b.mtime - a.mtime);

	const render = (detail: Detail, limit: number, gistCount: number): string => {
		const gisted = new Set(byRecency.slice(0, gistCount).map((n) => n.path));
		const lines: string[] = [];
		let folder: string | null = null;
		for (const note of notes.slice(0, limit)) {
			if (note.folder !== folder) {
				folder = note.folder;
				lines.push(folder === "" ? "/" : `${folder}/`);
			}
			let line = `  ${note.basename}`;
			if (detail !== "none") {
				const meta = vault.getMetadata(note.path);
				const g = detail === "gists" && gisted.has(note.path) ? gist?.(note.path) : undefined;
				if (g) {
					line += ` — ${g}`;
				} else {
					const headings = meta.headings
						.map((h) => h.replace(/^#+\s*/, "").trim())
						.filter(Boolean)
						.slice(0, 6)
						.map((h) => (h.length > 40 ? h.slice(0, 39) + "…" : h));
					if (headings.length) line += ` — ${headings.join(" › ")}`;
					if (meta.headings.length > 6) line += ` (+${meta.headings.length - 6})`;
				}
				const tags = meta.tags.slice(0, 4);
				if (tags.length) line += ` ${tags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ")}`;
			}
			lines.push(line);
		}
		if (limit < notes.length) lines.push(`…and ${notes.length - limit} more notes (use list_notes or search_notes).`);
		return lines.join("\n");
	};

	const fits = (s: string) => s.length <= budgetChars;
	const hasGists = gist !== undefined && notes.some((n) => gist(n.path));

	if (hasGists) {
		const all = render("gists", notes.length, notes.length);
		if (fits(all)) return all;
		// Ration gists to the K most recent notes; the rest show headings.
		const k = largest(notes.length, (n) => fits(render("gists", notes.length, n)));
		if (k > 0) return render("gists", notes.length, k);
	}
	const withHeadings = render("headings", notes.length, 0);
	if (fits(withHeadings)) return withHeadings;
	const bare = render("none", notes.length, 0);
	if (fits(bare)) return bare;
	const prefix = largest(notes.length, (n) => fits(render("none", n, 0)));
	return render("none", Math.max(prefix, 1), 0);
}

/** Largest n in [0, max] for which `ok(n)` holds, assuming monotonic `ok`. */
function largest(max: number, ok: (n: number) => boolean): number {
	let lo = 0;
	let hi = max;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (ok(mid)) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * Share of the context window (in characters, ~3.2 per token) spent on the outline: 12%
 * for names and headings, 30% when gists are available since they are what the budget buys.
 */
export function outlineBudget(numCtx: number, withGists = false): number {
	return Math.floor(numCtx * 3.2 * (withGists ? 0.3 : 0.12));
}
