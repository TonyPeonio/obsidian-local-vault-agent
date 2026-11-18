import type { NoteInfo, SearchHit, VaultAccess } from "./types";

/**
 * Keyword search over note names and bodies. It is the always-available baseline;
 * semantic results from the embedding index are merged on top with reciprocal rank
 * fusion in `hybridSearch`.
 */

const STOP = new Set([
	"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were",
	"my", "me", "i", "it", "this", "that", "with", "about", "what", "which", "who", "how", "do",
	"does", "did", "from", "by", "at", "as", "be", "have", "has", "had", "not", "all", "any",
	"notes", "note",
]);

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}_#-]+/u)
		.map((t) => t.replace(/^[-_#]+|[-_#]+$/g, ""))
		.filter((t) => t.length > 1);
}

export function queryTerms(query: string): string[] {
	const terms = tokenize(query).filter((t) => !STOP.has(t));
	return terms.length ? Array.from(new Set(terms)) : tokenize(query);
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = 0;
	while ((idx = haystack.indexOf(needle, idx)) >= 0) {
		count++;
		idx += needle.length;
	}
	return count;
}

/** `width` characters of `content` with `at` a third of the way in, whitespace collapsed, each cut marked with "…". */
function snippetAt(content: string, at: number, width: number): string {
	const start = Math.max(0, at - Math.floor(width / 3));
	const end = Math.min(content.length, start + width);
	let snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
	if (start > 0) snippet = "…" + snippet;
	if (end < content.length) snippet += "…";
	return snippet;
}

export function makeSnippet(content: string, terms: string[], width = 240): string {
	const lower = content.toLowerCase();
	let best = -1;
	for (const t of terms) {
		const i = lower.indexOf(t);
		if (i >= 0 && (best < 0 || i < best)) best = i;
	}
	return snippetAt(content, Math.max(0, best), width);
}

/**
 * A snippet of a passage found by meaning: the part of it where most of the query's words
 * occur together, or its start when it has none of them. A semantic hit's first 280
 * characters are often the lead-in, not the sentence the query was about. (makeSnippet, which
 * anchors on the first term it finds, is the cheap version for whole notes scored on those terms.)
 */
export function snippetNear(content: string, terms: string[], width = 280): string {
	const lower = content.toLowerCase();
	const spots: { at: number; term: number }[] = [];
	terms.forEach((t, k) => {
		for (let i = lower.indexOf(t); i >= 0 && spots.length < 500; i = lower.indexOf(t, i + t.length)) spots.push({ at: i, term: k });
	});
	spots.sort((a, b) => a.at - b.at);
	let best = 0;
	let most = 0;
	// The earliest place from which the snippet would cover the most different terms.
	const reach = Math.floor((width * 2) / 3);
	for (let s = 0; s < spots.length; s++) {
		const seen = new Set<number>();
		for (let e = s; e < spots.length && spots[e].at < spots[s].at + reach; e++) seen.add(spots[e].term);
		if (seen.size > most) {
			most = seen.size;
			best = spots[s].at;
		}
	}
	return snippetAt(content, best, width);
}

export async function keywordSearch(
	vault: VaultAccess,
	query: string,
	limit: number,
	notes: NoteInfo[] = vault.listNotes(),
	/** A faster source of a note's text than reading it (e.g. the semantic index's memory); undefined falls back to the vault. */
	textOf?: (note: NoteInfo) => string | undefined,
): Promise<SearchHit[]> {
	const terms = queryTerms(query);
	if (terms.length === 0) return [];
	const phrase = query.trim().toLowerCase();
	const scored: SearchHit[] = [];

	for (const note of notes) {
		const nameLower = note.basename.toLowerCase();
		const pathLower = note.path.toLowerCase();
		let score = 0;
		let content: string | null = null;

		for (const t of terms) {
			if (nameLower.includes(t)) score += 6;
			else if (pathLower.includes(t)) score += 2;
		}
		if (phrase.length > 3 && nameLower.includes(phrase)) score += 10;

		// Only read bodies for a bounded amount of work: names are cheap, bodies are not,
		// but a vault with a few thousand notes still reads in well under a second.
		content = textOf?.(note) ?? (await vault.read(note.path));
		const lower = content.toLowerCase();
		let matchedTerms = 0;
		for (const t of terms) {
			const n = countOccurrences(lower, t);
			if (n > 0) {
				matchedTerms++;
				score += Math.min(n, 8) * 1 + 1.5;
			}
		}
		if (phrase.length > 3 && lower.includes(phrase)) score += 8;
		// Reward notes that match every term over notes matching one term many times.
		if (matchedTerms === terms.length && terms.length > 1) score *= 1.5;
		// Mild length normalization so huge notes don't dominate on raw counts.
		score = score / Math.log2(8 + content.length / 2000);

		if (score > 0) {
			scored.push({ path: note.path, score, snippet: makeSnippet(content, terms) });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
}

/** Reciprocal rank fusion of several ranked lists, de-duplicated by path. */
export function fuseRankings(lists: SearchHit[][], limit: number, k = 60): SearchHit[] {
	const fused = new Map<string, SearchHit & { fused: number }>();
	lists.forEach((list) => {
		list.forEach((hit, rank) => {
			const contribution = 1 / (k + rank + 1);
			const existing = fused.get(hit.path);
			if (existing) {
				existing.fused += contribution;
				// Prefer the semantic snippet (list order: semantic first) but keep the first seen.
				if (!existing.snippet && hit.snippet) existing.snippet = hit.snippet;
			} else {
				fused.set(hit.path, { ...hit, fused: contribution });
			}
		});
	});
	return Array.from(fused.values())
		.sort((a, b) => b.fused - a.fused)
		.slice(0, limit)
		.map(({ fused, ...hit }) => ({ ...hit, score: Number(fused.toFixed(5)) }));
}

/** A note's properties as "key: value" lines: keyword search over text that has no frontmatter (the index's chunks) puts this in front. */
export function frontmatterText(frontmatter: Record<string, unknown> | null | undefined): string {
	if (!frontmatter) return "";
	return Object.entries(frontmatter)
		.filter(([k]) => k !== "position") // older Obsidian keeps a position object here
		.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)}`)
		.join("\n");
}
