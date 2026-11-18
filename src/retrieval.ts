import { queryTerms, tokenize } from "./search";

/**
 * The word-matching half of passage search. Embeddings find passages that mean the same as the
 * question; they are weak on exactly the things notes are full of: names, identifiers, numbers,
 * code, a rare term. This index scores every chunk by BM25 over its words, and `fuseKeyed` merges
 * that ranking with the embedding ranking. Pure (no Obsidian, no model), so it is unit-tested and
 * scored by `npm run bench:retrieval`.
 */

/** A light stemmer: plural forms only, so "sensors" finds "sensor" without the damage a full stemmer does to names and code. */
export function stem(token: string): string {
	if (token.length <= 3 || /[^a-z]/.test(token)) return token;
	if (token.endsWith("ies") && token.length > 4) return token.slice(0, -3) + "y";
	if (token.endsWith("sses")) return token.slice(0, -2);
	if (token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
	return token;
}

/** The index terms of a text: lower-cased words and numbers, plural-stemmed. */
export function lexTokens(text: string): string[] {
	return tokenize(text).map(stem);
}

/** The terms a question is searched by: stop words dropped, stemmed, each once. */
export function lexQueryTerms(query: string): string[] {
	return Array.from(new Set(queryTerms(query).map(stem)));
}

export interface LexHit {
	path: string;
	/** Index of the chunk within its note, in the order the chunker produced them. */
	idx: number;
	score: number;
	/** How many of the query's terms the chunk contains. */
	matched: number;
	terms: number;
}

interface LexDoc {
	path: string;
	idx: number;
	len: number;
}

const K1 = 1.2;
const B = 0.75;
/** A term in the note title or heading counts this many times: a section called "Dijkstra" is about Dijkstra. */
const HEADING_WEIGHT = 3;

export class LexicalIndex {
	/** term → [docId, tf, docId, tf, …]. */
	private postings = new Map<string, number[]>();
	private docs: (LexDoc | null)[] = [];
	private byPath = new Map<string, number[]>();
	private live = 0;
	private dead = 0;
	private totalLen = 0;

	get size(): number {
		return this.live;
	}

	clear(): void {
		this.postings.clear();
		this.docs = [];
		this.byPath.clear();
		this.live = 0;
		this.dead = 0;
		this.totalLen = 0;
	}

	has(path: string): boolean {
		return this.byPath.has(path);
	}

	/** Replace a note's chunks. `title` is the note's name; it and each chunk's heading weigh more than body text. */
	setFile(path: string, chunks: { heading: string; text: string }[], title = ""): void {
		this.remove(path);
		if (chunks.length === 0) return;
		const ids: number[] = [];
		chunks.forEach((chunk, idx) => {
			const tf = new Map<string, number>();
			let len = 0;
			for (const t of lexTokens(chunk.text)) {
				tf.set(t, (tf.get(t) ?? 0) + 1);
				len++;
			}
			for (const t of lexTokens(`${title} ${chunk.heading}`)) tf.set(t, (tf.get(t) ?? 0) + HEADING_WEIGHT);
			const id = this.docs.length;
			this.docs.push({ path, idx, len: Math.max(1, len) });
			ids.push(id);
			this.totalLen += Math.max(1, len);
			this.live++;
			for (const [term, n] of tf) {
				let list = this.postings.get(term);
				if (!list) this.postings.set(term, (list = []));
				list.push(id, n);
			}
		});
		this.byPath.set(path, ids);
	}

	remove(path: string): void {
		const ids = this.byPath.get(path);
		if (!ids) return;
		for (const id of ids) {
			const d = this.docs[id];
			if (!d) continue;
			this.totalLen -= d.len;
			this.docs[id] = null;
			this.live--;
			this.dead++;
		}
		this.byPath.delete(path);
		// Removed chunks stay in the posting lists until they outnumber the live ones; then one pass drops them.
		if (this.dead > 1000 && this.dead > this.live) this.compact();
	}

	rename(oldPath: string, newPath: string): void {
		const ids = this.byPath.get(oldPath);
		if (!ids) return;
		this.byPath.delete(oldPath);
		this.byPath.set(newPath, ids);
		for (const id of ids) {
			const d = this.docs[id];
			if (d) d.path = newPath;
		}
	}

	private compact(): void {
		const remap = new Int32Array(this.docs.length).fill(-1);
		const docs: LexDoc[] = [];
		this.docs.forEach((d, id) => {
			if (!d) return;
			remap[id] = docs.length;
			docs.push(d);
		});
		for (const [term, list] of this.postings) {
			const next: number[] = [];
			for (let i = 0; i < list.length; i += 2) {
				const id = remap[list[i]];
				if (id >= 0) next.push(id, list[i + 1]);
			}
			if (next.length) this.postings.set(term, next);
			else this.postings.delete(term);
		}
		this.docs = docs;
		this.byPath.clear();
		docs.forEach((d, id) => {
			const ids = this.byPath.get(d.path);
			if (ids) ids.push(id);
			else this.byPath.set(d.path, [id]);
		});
		this.dead = 0;
	}

	/**
	 * The chunks that best match the query's words, best first. `textOf` (the chunk's text) lets a
	 * chunk that contains the whole question as a phrase rank above one that only has its words.
	 * `extraTerms` are searched as given, on top of the question's own words (the ISO dates a
	 * question names in words, for one).
	 */
	search(query: string, limit: number, textOf?: (path: string, idx: number) => string | undefined, extraTerms: string[] = []): LexHit[] {
		const terms = Array.from(new Set([...lexQueryTerms(query), ...extraTerms.map((t) => t.toLowerCase())]));
		if (terms.length === 0 || this.live === 0) return [];
		const avgLen = this.totalLen / this.live;
		const acc = new Map<number, { score: number; matched: number }>();
		for (const term of terms) {
			const list = this.postings.get(term);
			if (!list) continue;
			let df = 0;
			for (let i = 0; i < list.length; i += 2) if (this.docs[list[i]]) df++;
			if (df === 0) continue;
			const idf = Math.log(1 + (this.live - df + 0.5) / (df + 0.5));
			for (let i = 0; i < list.length; i += 2) {
				const doc = this.docs[list[i]];
				if (!doc) continue;
				const tf = list[i + 1];
				const s = (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.len) / avgLen));
				const a = acc.get(list[i]);
				if (a) {
					a.score += s;
					a.matched++;
				} else acc.set(list[i], { score: s, matched: 1 });
			}
		}
		// A chunk with every term beats one that repeats a single term.
		const hits: LexHit[] = [];
		for (const [id, a] of acc) {
			const doc = this.docs[id] as LexDoc;
			hits.push({ path: doc.path, idx: doc.idx, score: a.score * (0.5 + (0.5 * a.matched) / terms.length), matched: a.matched, terms: terms.length });
		}
		hits.sort((x, y) => y.score - x.score);
		const top = hits.slice(0, Math.max(limit, 50));
		const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
		if (textOf && phrase.length > 5 && terms.length > 1) {
			for (const h of top) {
				const text = textOf(h.path, h.idx);
				if (text && text.toLowerCase().replace(/\s+/g, " ").includes(phrase)) h.score *= 2;
			}
			top.sort((x, y) => y.score - x.score);
		}
		return top.slice(0, limit);
	}
}

/**
 * Reciprocal rank fusion of ranked lists whose entries are identified by `key`. The first list
 * that contains an entry supplies the item that is returned. `weights` scales each list's say
 * (default 1 each).
 */
export function fuseKeyed<T>(lists: { key: string; item: T }[][], limit: number, k = 60, weights: number[] = []): { item: T; fused: number; ranks: (number | undefined)[] }[] {
	const fused = new Map<string, { item: T; fused: number; ranks: (number | undefined)[] }>();
	lists.forEach((list, li) => {
		list.forEach((entry, rank) => {
			let f = fused.get(entry.key);
			if (!f) fused.set(entry.key, (f = { item: entry.item, fused: 0, ranks: lists.map(() => undefined) }));
			if (f.ranks[li] !== undefined) return; // the same passage twice in one list counts once
			f.fused += (weights[li] ?? 1) / (k + rank + 1);
			f.ranks[li] = rank;
		});
	});
	return Array.from(fused.values())
		.sort((a, b) => b.fused - a.fused)
		.slice(0, limit);
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function iso(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(d: Date, n: number): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function monthIndex(word: string): number {
	const w = word.toLowerCase().replace(/\.$/, "");
	if (w.length < 3) return -1;
	return MONTH_NAMES.findIndex((m) => m === w || (w.length <= 4 && m.startsWith(w)));
}

/** A day and month with no year: the latest such date that is not more than two months ahead of today. */
function nearest(month: number, day: number, now: Date, year?: number): string | undefined {
	if (day < 1 || day > 31 || month < 0 || month > 11) return undefined;
	let y = year ?? now.getFullYear();
	if (year === undefined && new Date(y, month, day).getTime() > addDays(now, 60).getTime()) y--;
	const d = new Date(y, month, day);
	return d.getMonth() === month ? iso(d) : undefined; // 31 February is not a date
}

/**
 * The calendar days a question names, as `YYYY-MM-DD`: "September 10", "Sept 10th, 2026",
 * "10 September", "9/10", "yesterday", "last Tuesday", "this week", "the last 5 days". Notes are
 * dated by ISO day in file names and headings, and neither an embedding nor a word match
 * connects "September 10" to `2026-09-10` on its own. At most 14 days; today is `now`'s local date.
 */
export function dateTerms(query: string, now: Date): string[] {
	const out = new Set<string>();
	const q = query.toLowerCase();
	const add = (s: string | undefined) => {
		if (s && out.size < 14) out.add(s);
	};
	for (const m of q.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m[0]);
	// "september 10", "sept. 10th, 2026"
	for (const m of q.matchAll(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/g)) {
		const mi = monthIndex(m[1]);
		if (mi >= 0) add(nearest(mi, Number(m[2]), now, m[3] ? Number(m[3]) : undefined));
	}
	// "10 september", "10th of september 2026"
	for (const m of q.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\.?(?:,?\s+(\d{4}))?\b/g)) {
		const mi = monthIndex(m[2]);
		if (mi >= 0) add(nearest(mi, Number(m[1]), now, m[3] ? Number(m[3]) : undefined));
	}
	// "9/10", "9/10/2026", "9/10/26": month first unless the first number cannot be a month.
	for (const m of q.matchAll(/(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g)) {
		let a = Number(m[1]);
		let b = Number(m[2]);
		if (a > 12 && b <= 12) [a, b] = [b, a];
		const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
		add(nearest(a - 1, b, now, year));
	}
	if (/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b/.test(q)) add(iso(now));
	if (/\byesterday\b|\blast night\b/.test(q)) add(iso(addDays(now, -1)));
	if (/\btomorrow\b/.test(q)) add(iso(addDays(now, 1)));
	if (/\bday before yesterday\b/.test(q)) add(iso(addDays(now, -2)));
	for (const m of q.matchAll(/\b(last|this|on|past)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
		const want = WEEKDAYS.indexOf(m[2]);
		let back = (now.getDay() - want + 7) % 7;
		if (m[1] === "last" && back === 0) back = 7;
		add(iso(addDays(now, -back)));
	}
	const monday = addDays(now, -((now.getDay() + 6) % 7));
	if (/\bthis week\b/.test(q)) for (let d = monday; d.getTime() <= now.getTime(); d = addDays(d, 1)) add(iso(d));
	if (/\blast week\b/.test(q)) for (let i = 7; i >= 1; i--) add(iso(addDays(monday, -i)));
	const span = /\b(?:last|past|previous)\s+(\d{1,2}|two|three|four|five|six|seven)\s+days\b/.exec(q);
	if (span) {
		const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
		const n = Math.min(14, words[span[1]] ?? Number(span[1]));
		for (let i = 0; i < n; i++) add(iso(addDays(now, -i)));
	}
	return Array.from(out);
}
