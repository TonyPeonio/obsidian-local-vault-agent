import { stripFrontmatter } from "./chunker";
import { matchPassages, passageLink, plainText } from "./citations";
import { OllamaError, type OllamaClient } from "./ollama";
import type { LectureInfo, NoteInfo } from "./types";

/**
 * "Quiz me on <topic or course> since <date>": questions generated from the matching notes, asked
 * one at a time in the chat, each answer graded against the passage it came from (cited), and the
 * missed ones written, after a diff the user approves, to a review note. The model is called
 * without tools: once to write the questions (with the notes in the prompt) and once per answer.
 */

export interface QuizRequest {
	topic: string;
	/** YYYY-MM-DD, or undefined for all time. */
	since?: string;
}

export interface QuizQuestion {
	question: string;
	answer: string;
	/** Note path the question came from. */
	source: string;
	/** The sentence(s) of the note that hold the answer, as the model copied them. */
	quote: string;
	/** Link to the paragraph that holds the answer (heading or block link; never needs a write). */
	cite: string;
}

export type Verdict = "correct" | "partial" | "wrong";

export interface QuizResult {
	question: QuizQuestion;
	given: string;
	verdict: Verdict;
	feedback: string;
}

function iso(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * A date phrase as YYYY-MM-DD, relative to `now`: "2026-10-01", "yesterday", "last week",
 * "last month", "3 days ago", "the last 2 weeks", "monday", "Oct 3", "October 3rd", "10/3".
 * Null when it is not a date.
 */
export function parseSince(phrase: string, now: Date): string | null {
	const p = phrase.trim().toLowerCase().replace(/[.,!?]+$/, "").replace(/^(the|this)\s+/, "");
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const isoM = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(p);
	if (isoM) return `${isoM[1]}-${isoM[2].padStart(2, "0")}-${isoM[3].padStart(2, "0")}`;
	if (p === "today") return iso(d);
	if (p === "yesterday") return iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
	const unit = (u: string) => (u.startsWith("day") ? 1 : u.startsWith("week") ? 7 : u.startsWith("month") ? 30 : u.startsWith("year") ? 365 : 0);
	const last = /^(?:last|past)\s+(?:(\d+|a|one|two|three|four)\s+)?(day|days|week|weeks|month|months|year|years)$/.exec(p);
	const ago = /^(\d+|a|one|two|three|four)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/.exec(p);
	const m = last ?? ago;
	if (m) {
		const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4 };
		const n = m[1] === undefined ? 1 : (words[m[1]] ?? Number(m[1]));
		return iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n * unit(m[2])));
	}
	const dayIdx = DAYS.findIndex((x) => p === x || p === `last ${x}` || p === x.slice(0, 3));
	if (dayIdx >= 0) {
		const back = ((d.getDay() - dayIdx + 7) % 7) || 7;
		return iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
	}
	const md = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(p) ?? null;
	const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(p);
	let month = -1;
	let day = 0;
	let year: number | null = null;
	if (md && MONTHS.includes(md[1].slice(0, 3))) {
		month = MONTHS.indexOf(md[1].slice(0, 3));
		day = Number(md[2]);
		year = md[3] ? Number(md[3]) : null;
	} else if (slash) {
		month = Number(slash[1]) - 1;
		day = Number(slash[2]);
		year = slash[3] ? Number(slash[3]) : null;
	}
	if (month >= 0 && month < 12 && day >= 1 && day <= 31) {
		let y = year ?? d.getFullYear();
		if (year === null && new Date(y, month, day).getTime() > d.getTime()) y--;
		return iso(new Date(y, month, day));
	}
	return null;
}

/** "Quiz me on CSCI 470 since October 1" → { topic, since }, or null when the text is not a quiz request. */
export function parseQuizRequest(text: string, now: Date): QuizRequest | null {
	const t = text.trim().replace(/[.!?]+$/, "");
	const m = /^(?:please\s+)?(?:quiz|test)\s+me(?:\s+(?:on|about|over|from))?\s*(.*)$/i.exec(t);
	if (!m) return null;
	let rest = m[1].trim();
	let since: string | undefined;
	const sinceM = /\s*\b(?:since|from|after|starting)\s+(.+)$/i.exec(rest) ?? /\s*\b(?:in|from|over)\s+(the\s+(?:last|past)\s+.+)$/i.exec(rest) ?? /\s*\b((?:last|this)\s+(?:week|month))$/i.exec(rest);
	if (sinceM) {
		const parsed = parseSince(sinceM[1].replace(/^this\s+week$/i, "last week").replace(/^this\s+month$/i, "last month"), now);
		if (parsed) {
			since = parsed;
			rest = rest.slice(0, sinceM.index).trim();
		}
	}
	rest = rest.replace(/^(?:my|the)\s+/i, "").replace(/\s+(?:notes|lectures|course)$/i, "").trim();
	return { topic: rest, since };
}

/** The date a note is about: its YYYY-MM-DD in the name or path, else its modified day. */
export function noteDate(n: NoteInfo): string {
	return /(\d{4}-\d{2}-\d{2})/.exec(n.path)?.[1] ?? iso(new Date(n.mtime));
}

/**
 * The notes a quiz on `topic` since `since` is drawn from, oldest first, at most `max`. With
 * Lecture Companion's lectures: the lectures of the courses the topic names. Otherwise the notes
 * whose path contains every word of the topic. Empty when nothing matches by name (the caller
 * then searches by meaning).
 */
export function selectQuizNotes(notes: NoteInfo[], req: QuizRequest, lectures: LectureInfo[] = [], max = 12): string[] {
	const topic = req.topic.trim().toLowerCase();
	const since = req.since ?? "0000-00-00";
	if (lectures.length) {
		const courses = Array.from(new Set(lectures.map((l) => l.course)));
		const match = courses.filter((c) => topic && (c.toLowerCase().includes(topic) || topic.includes(c.toLowerCase())));
		if (match.length || !topic) {
			const picked = lectures
				.filter((l) => (!topic || match.includes(l.course)) && l.date >= since)
				.sort((a, b) => a.date.localeCompare(b.date))
				.map((l) => l.path);
			if (picked.length) return picked.slice(-max);
		}
	}
	const words = topic.split(/\s+/).filter((w) => w.length >= 2);
	if (words.length === 0) return [];
	return notes
		.filter((n) => {
			const p = n.path.toLowerCase();
			return words.every((w) => p.includes(w)) && noteDate(n) >= since;
		})
		.sort((a, b) => noteDate(a).localeCompare(noteDate(b)))
		.map((n) => n.path)
		.slice(-max);
}

/** Note text for the question prompt: no frontmatter, no embeds, budgeted per note. */
export function quizSourceText(content: string, budget: number): string {
	const body = stripFrontmatter(content).body.replace(/!\[\[[^\]]*\]\]/g, "").replace(/\n{3,}/g, "\n\n").trim();
	return body.length > budget ? body.slice(0, budget) + "\n[…]" : body;
}

export function questionsPrompt(topic: string, notes: { path: string; text: string }[], count: number): string {
	return [
		`Write ${count} quiz questions${topic ? ` on ${topic}` : ""} from the notes below, to test whether I remember them. Spread them over the notes; prefer definitions, key facts, reasons, formulas and decisions over trivia like dates of class.`,
		'Reply with JSON only: {"questions": [{"question": "...", "answer": "the correct answer in one or two sentences", "source": "the note path exactly as given after ---", "quote": "the sentence from that note that holds the answer, copied word for word"}]}',
		"Use only what the notes say; every answer must be in its quote.",
		"",
		...notes.map((n) => `--- ${n.path} ---\n${n.text}`),
	].join("\n");
}

/** The JSON object or array in a model reply (code fences and chatter around it ignored), or null. */
export function extractJson(raw: string): unknown {
	const t = raw.replace(/```(?:json)?/gi, "").trim();
	for (const [open, close] of [
		["{", "}"],
		["[", "]"],
	]) {
		const a = t.indexOf(open);
		const b = t.lastIndexOf(close);
		if (a >= 0 && b > a) {
			try {
				return JSON.parse(t.slice(a, b + 1));
			} catch {
				// try the other shape
			}
		}
	}
	return null;
}

/**
 * The questions from the model's reply that can be checked: a question and an answer, and a source
 * among `notes`. Each gets a citation to the paragraph holding its quote (or answer) by heading.
 */
export function parseQuestions(raw: string, notes: { path: string; content: string }[]): QuizQuestion[] {
	const json = extractJson(raw);
	const list = Array.isArray(json) ? json : Array.isArray((json as { questions?: unknown } | null)?.questions) ? (json as { questions: unknown[] }).questions : [];
	const out: QuizQuestion[] = [];
	for (const item of list) {
		const q = item as Record<string, unknown>;
		const question = typeof q.question === "string" ? q.question.trim() : "";
		const answer = typeof q.answer === "string" ? q.answer.trim() : "";
		const quote = typeof q.quote === "string" ? q.quote.trim() : "";
		const src = typeof q.source === "string" ? q.source.trim().replace(/^\[\[|\]\]$/g, "") : "";
		if (!question || !answer) continue;
		const noMd = (s: string) => s.replace(/\.md$/i, "").toLowerCase();
		const note =
			notes.find((n) => noMd(n.path) === noMd(src)) ??
			notes.find((n) => noMd(n.path).endsWith("/" + noMd(src)) || (n.path.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase() === noMd(src)) ??
			(quote ? notes.find((n) => plainText(n.content).includes(plainText(quote))) : undefined);
		if (!note) continue;
		const para = (quote ? matchPassages(`"${quote}"`, note.content, 1)[0] : undefined) ?? matchPassages(`${question} ${answer}`, note.content, 1)[0];
		const cite = para ? passageLink(note.path, para, para.blockId) : `[[${note.path.replace(/\.md$/i, "")}]]`;
		if (out.some((o) => o.question.toLowerCase() === question.toLowerCase())) continue;
		out.push({ question, answer, source: note.path, quote, cite });
	}
	return out;
}

/** An answer that is no answer ("skip", "idk", "?"), graded wrong without asking the model. */
export function isNonAnswer(text: string): boolean {
	return /^\s*(?:|\?+|skip|pass|next|idk|i\s*don'?t\s*know|no idea|dunno|-+)\s*[.!]*\s*$/i.test(text);
}

export function gradePrompt(q: QuizQuestion, given: string, sourceText: string): string {
	return [
		"Grade a student's answer to a quiz question against the source notes. Be fair: the wording may differ, but the facts must match. A partly right or incomplete answer is 'partial'.",
		'Reply with JSON only: {"verdict": "correct" | "partial" | "wrong", "feedback": "one or two sentences to the student: what was right, what was missing or wrong"}',
		"",
		`Question: ${q.question}`,
		`Expected answer: ${q.answer}`,
		q.quote ? `Source passage: ${q.quote}` : "",
		sourceText ? `More of the source:\n${sourceText}` : "",
		"",
		`Student's answer: ${given}`,
	]
		.filter((l) => l !== "")
		.join("\n");
}

export function parseGrade(raw: string): { verdict: Verdict; feedback: string } {
	const json = extractJson(raw) as { verdict?: unknown; feedback?: unknown } | null;
	const v = typeof json?.verdict === "string" ? json.verdict.toLowerCase() : "";
	const feedback = typeof json?.feedback === "string" ? json.feedback.trim() : raw.replace(/[{}"]/g, "").trim().slice(0, 400);
	const verdict: Verdict = /partial|partly/.test(v) ? "partial" : /correct|right/.test(v) && !/incorrect/.test(v) ? "correct" : v ? "wrong" : /\bpartial/i.test(raw) ? "partial" : /\bincorrect|\bwrong/i.test(raw) ? "wrong" : /\bcorrect\b/i.test(raw) ? "correct" : "wrong";
	return { verdict, feedback };
}

/** One quiz in progress: which question is asked, and the results so far. */
export class QuizSession {
	readonly results: QuizResult[] = [];
	private index = 0;

	constructor(
		readonly topic: string,
		readonly questions: QuizQuestion[],
		readonly since?: string,
	) {}

	current(): QuizQuestion | null {
		return this.questions[this.index] ?? null;
	}

	get number(): number {
		return this.index + 1;
	}

	record(given: string, verdict: Verdict, feedback: string): QuizResult {
		const q = this.current();
		if (!q) throw new Error("The quiz is over.");
		const r = { question: q, given, verdict, feedback };
		this.results.push(r);
		this.index++;
		return r;
	}

	done(): boolean {
		return this.index >= this.questions.length;
	}

	missed(): QuizResult[] {
		return this.results.filter((r) => r.verdict !== "correct");
	}

	/** "4 of 5 right (1 partly)". */
	score(): string {
		const right = this.results.filter((r) => r.verdict === "correct").length;
		const partial = this.results.filter((r) => r.verdict === "partial").length;
		return `${right} of ${this.results.length} right${partial ? ` (${partial} partly)` : ""}`;
	}
}

export function questionMarkdown(s: QuizSession): string {
	const q = s.current();
	return q ? `**Question ${s.number} of ${s.questions.length}.** ${q.question}` : "";
}

export function resultMarkdown(r: QuizResult): string {
	const head = r.verdict === "correct" ? "✅ **Correct.**" : r.verdict === "partial" ? "🟡 **Partly.**" : "❌ **Not quite.**";
	return [`${head} ${r.feedback}`.trim(), "", `**Answer:** ${r.question.answer} — ${r.question.cite}`].join("\n");
}

/** File-name-safe version of the topic. */
function safeName(s: string): string {
	return s.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim() || "General";
}

export function reviewNotePath(folder: string, topic: string): string {
	const f = folder.replace(/^\/+|\/+$/g, "");
	return `${f ? f + "/" : ""}Quiz review - ${safeName(topic)}.md`;
}

/** The review note with this quiz's missed questions added as a dated section (no checkboxes, so task queries stay clean). */
export function renderReview(existing: string | null, topic: string, date: string, missed: QuizResult[]): string {
	const section = [
		`## ${date}`,
		"",
		...missed.flatMap((r) => [
			`### ${r.question.question.replace(/\n+/g, " ")}`,
			`- Your answer: ${r.given.replace(/\n+/g, " ").trim() || "(none)"}`,
			`- Answer: ${r.question.answer.replace(/\n+/g, " ")} (${r.question.cite})`,
			...(r.feedback ? [`- Note: ${r.feedback.replace(/\n+/g, " ")}`] : []),
			"",
		]),
	].join("\n");
	if (existing === null) return `# Quiz review: ${topic || "General"}\n\nQuestions I missed in quizzes, with the answer and where it is in my notes.\n\n${section}`;
	return `${existing.trimEnd()}\n\n${section}`;
}

export interface QuizModelConfig {
	model: string;
	numCtx: number;
	keepAlive: string;
}

/** The two model calls of a quiz. */
export class QuizEngine {
	constructor(
		private client: OllamaClient,
		private config: () => QuizModelConfig,
	) {}

	private async ask(prompt: string, signal?: AbortSignal): Promise<string> {
		const cfg = this.config();
		let think: boolean | undefined = false;
		for (;;) {
			try {
				const res = await this.client.chat({
					model: cfg.model,
					messages: [{ role: "user", content: prompt }],
					think,
					format: "json",
					options: { num_ctx: cfg.numCtx, temperature: 0.4 },
					keep_alive: cfg.keepAlive,
					signal,
				});
				return res.message.content;
			} catch (err) {
				if (think !== undefined && err instanceof OllamaError && /think/i.test(err.message)) {
					think = undefined;
					continue;
				}
				throw err;
			}
		}
	}

	/** Questions from the notes (contents keyed by path), at most `count`. */
	async questions(topic: string, notes: { path: string; content: string }[], count = 5, signal?: AbortSignal): Promise<QuizQuestion[]> {
		const perNote = Math.max(1500, Math.floor(40000 / Math.max(1, notes.length)));
		const prompt = questionsPrompt(topic, notes.map((n) => ({ path: n.path, text: quizSourceText(n.content, perNote) })), count);
		const parsed = parseQuestions(await this.ask(prompt, signal), notes);
		return parsed.slice(0, count);
	}

	async grade(q: QuizQuestion, given: string, sourceText: string, signal?: AbortSignal): Promise<{ verdict: Verdict; feedback: string }> {
		if (isNonAnswer(given)) return { verdict: "wrong", feedback: "No answer given." };
		return parseGrade(await this.ask(gradePrompt(q, given, sourceText), signal));
	}
}
