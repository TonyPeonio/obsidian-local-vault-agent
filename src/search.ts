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

export function makeSnippet(content: string, terms: string[], width = 240): string {
	const lower = content.toLowerCase();
	let best = -1;
	for (const t of terms) {
		const i = lower.indexOf(t);
		if (i >= 0 && (best < 0 || i < best)) best = i;
	}
	if (best < 0) best = 0;
	const start = Math.max(0, best - Math.floor(width / 3));
	const end = Math.min(content.length, start + width);
	let snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
	if (start > 0) snippet = "…" + snippet;
	if (end < content.length) snippet += "…";
	return snippet;
}

export async function keywordSearch(
	vault: VaultAccess,
	query: string,
	limit: number,
	notes: NoteInfo[] = vault.listNotes(),
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
		content = await vault.read(note.path);
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
