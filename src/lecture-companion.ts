import { ToolError } from "./tools";
import type { LectureInfo, LectureSource, ToolDefinition, TranscriptParagraph, VaultAccess } from "./types";

/**
 * The bridge to Lecture Companion (plugin id `lecture-companion`), through the API it exposes on
 * `app.plugins.plugins["lecture-companion"].api` (version 1). With it the agent gets lectures and
 * timestamped transcript paragraphs as structured data instead of reading conventions from AGENT.md
 * and searching; without it nothing here is used. Pure: no Obsidian imports.
 */

export const LECTURE_COMPANION_ID = "lecture-companion";

/** Lecture Companion's public API, version 1 (implemented on its side; keep the two in step). */
export interface LectureCompanionApi extends LectureSource {
	version: number;
	transcribe(wav16kMono: ArrayBuffer): Promise<string>;
	ollama(): { url: string; model: string };
}

/** This plugin's own public API on `app.plugins.plugins["local-vault-agent"].api`. */
export interface LocalVaultAgentApi {
	version: 1;
	/** Opens the chat with the note attached as context and a prompt to ask about it. */
	openChatAbout(path: string): Promise<void>;
	ollama(): { url: string; model: string };
}

/**
 * Lecture Companion's API from Obsidian's plugin registry (`app.plugins.plugins`), or null when the
 * plugin is not installed or enabled, or exposes an API version this build does not know.
 */
export function lectureCompanionApi(app: unknown): LectureCompanionApi | null {
	const registry = (app as { plugins?: { plugins?: Record<string, { api?: unknown } | undefined> } } | null)?.plugins?.plugins;
	const api = registry?.[LECTURE_COMPANION_ID]?.api as Partial<LectureCompanionApi> | undefined;
	if (!api || api.version !== 1) return null;
	for (const fn of ["courses", "lectures", "transcript", "transcribe", "ollama"] as const) {
		if (typeof api[fn] !== "function") return null;
	}
	return api as LectureCompanionApi;
}

/** Seconds → `m:ss` (or `h:mm:ss`), the way Lecture Companion writes `**[m:ss]**`. */
export function formatTimestamp(sec: number): string {
	const s = Math.max(0, Math.floor(sec));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** Words of 3+ letters, lower case, for matching a query against transcript paragraphs. */
function terms(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.'-]*/gu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));
}

const STOP = new Set(["the", "and", "for", "what", "when", "did", "say", "said", "about", "that", "this", "with", "was", "were", "professor", "lecture", "time", "how", "why", "which", "from", "into", "are", "you", "can"]);

/**
 * The paragraphs of a transcript that best match `query` (by distinct query terms they contain,
 * a term inside a longer word counting as half), each with its index, best first, at most `limit`.
 * An empty query keeps every paragraph in order.
 */
export function matchParagraphs(paragraphs: TranscriptParagraph[], query: string, limit = 8): { index: number; score: number }[] {
	const q = Array.from(new Set(terms(query)));
	if (q.length === 0) return paragraphs.slice(0, limit).map((_, index) => ({ index, score: 0 }));
	const scored = paragraphs.map((p, index) => {
		const words = new Set(terms(p.text));
		const lower = p.text.toLowerCase();
		let score = 0;
		for (const t of q) {
			if (words.has(t)) score += 1;
			else if (lower.includes(t)) score += 0.5;
		}
		return { index, score };
	});
	return scored
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit);
}

/** A lecture named by path, note name, or "<course> <date>", among Lecture Companion's lectures. */
export function findLecture(lectures: LectureInfo[], vault: VaultAccess, input: string): LectureInfo | null {
	const raw = input.trim().replace(/^\[\[|\]\]$/g, "").replace(/#.*$/, "");
	const resolved = vault.resolve(raw);
	if (resolved) {
		const hit = lectures.find((l) => l.path === resolved);
		if (hit) return hit;
	}
	const noMd = raw.replace(/\.md$/i, "").toLowerCase();
	const exact = lectures.find((l) => l.path.replace(/\.md$/i, "").toLowerCase() === noMd);
	if (exact) return exact;
	const date = /\d{4}-\d{2}-\d{2}/.exec(raw)?.[0];
	if (date) {
		const sameDay = lectures.filter((l) => l.date === date);
		if (sameDay.length === 1) return sameDay[0];
		const lower = raw.toLowerCase();
		const course = sameDay.find((l) => lower.includes(l.course.toLowerCase()));
		if (course) return course;
	}
	return null;
}

function str(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

export const listLectures: ToolDefinition = {
	name: "list_lectures",
	description:
		"List the lectures and meetings Lecture Companion recorded, from its own records: date, course, kind, note path and its one-sentence summary. Filter by course, by date range (since/until, YYYY-MM-DD) or by words in the summary. The way to find which lecture covered something before reading its transcript with lecture_transcript.",
	parameters: {
		type: "object",
		properties: {
			course: { type: "string", description: "Course name (as list_lectures shows it); omit for every course." },
			since: { type: "string", description: "Only lectures on or after this date (YYYY-MM-DD)." },
			until: { type: "string", description: "Only lectures on or before this date (YYYY-MM-DD)." },
			contains: { type: "string", description: "Only lectures whose summary sentence or course mentions these words." },
		},
	},
	mutates: false,
	async execute(args, ctx) {
		const lc = ctx.lectures;
		if (!lc) throw new ToolError("Lecture Companion is not installed; search the notes instead.");
		const course = str(args, "course");
		const courses = lc.courses();
		let list = lc.lectures(course || undefined);
		if (course && list.length === 0) {
			const near = courses.find((c) => c.toLowerCase().includes(course.toLowerCase()) || course.toLowerCase().includes(c.toLowerCase()));
			if (near) list = lc.lectures(near);
		}
		const since = str(args, "since");
		const until = str(args, "until");
		if (since) list = list.filter((l) => l.date >= since);
		if (until) list = list.filter((l) => l.date <= until);
		const contains = str(args, "contains");
		if (contains) {
			const q = terms(contains);
			list = list.filter((l) => {
				const hay = `${l.course} ${l.sentence ?? ""}`.toLowerCase();
				return q.some((t) => hay.includes(t));
			});
		}
		list = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.course.localeCompare(b.course));
		const header = `${list.length} lecture${list.length === 1 ? "" : "s"}${course ? ` in ${course}` : ""}. Courses: ${courses.join(", ") || "(none)"}.`;
		if (list.length === 0) return `${header}\nNo lectures match.`;
		// As many rows as the result can hold (the agent cuts a longer one, and the count of what is missing with it).
		const lines: string[] = [];
		let room = ctx.maxResultChars - header.length - `\n… ${list.length} more; narrow with course or since/until.`.length;
		for (const l of list.slice(0, 200)) {
			const line = `${l.date} · ${l.course} · ${l.kind} · ${l.path}${l.sentence ? ` — ${l.sentence}` : ""}`;
			if (lines.length > 0 && line.length + 1 > room) break;
			lines.push(line);
			room -= line.length + 1;
		}
		if (list.length > lines.length) lines.push(`… ${list.length - lines.length} more; narrow with course or since/until.`);
		return `${header}\n${lines.join("\n")}`;
	},
};

export const lectureTranscript: ToolDefinition = {
	name: "lecture_transcript",
	description:
		"The transcript of one lecture as timestamped paragraphs [m:ss], from Lecture Companion. With query, only the paragraphs that match it best (and their neighbours); without, the whole transcript from the start. Use it for 'what did the professor say about X, and when': quote the paragraph and give its [m:ss] time, citing the lecture note.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "The lecture note's path (from list_lectures), or '<course> <date>'." },
			query: { type: "string", description: "Words to look for, e.g. 'contamination isolation forest'." },
		},
		required: ["path"],
	},
	mutates: false,
	async execute(args, ctx) {
		const lc = ctx.lectures;
		if (!lc) throw new ToolError("Lecture Companion is not installed; read the note's Transcript section instead.");
		const input = str(args, "path");
		if (!input) throw new ToolError('Missing required argument "path".');
		const lecture = findLecture(lc.lectures(), ctx.vault, input);
		const path = lecture?.path ?? ctx.vault.resolve(input);
		if (!path) throw new ToolError(`No lecture found for "${input}". Use list_lectures to find its path.`);
		const paragraphs = await lc.transcript(path);
		if (paragraphs.length === 0) return `${path} has no transcript.`;
		const query = str(args, "query");
		let keep: number[];
		if (query) {
			const best = matchParagraphs(paragraphs, query, 5);
			if (best.length === 0) return `# ${path} (transcript, ${paragraphs.length} paragraphs)\nNo paragraph mentions "${query}". Try other words, or call lecture_transcript without query to read it from the start.`;
			const set = new Set<number>();
			for (const b of best) for (const i of [b.index - 1, b.index, b.index + 1]) if (i >= 0 && i < paragraphs.length) set.add(i);
			keep = Array.from(set).sort((a, b) => a - b);
		} else keep = paragraphs.map((_, i) => i);
		const head = `# ${path} (transcript${lecture ? `, ${lecture.course}, ${lecture.date}` : ""}, ${paragraphs.length} paragraphs${query ? `, best matches for "${query}"` : ""})`;
		const tail = `\n---\nQuote the paragraph you use with its [m:ss] time and cite [[${path.replace(/\.md$/i, "")}]].`;
		const continues = (n: number) => `[… transcript continues; ${n} more paragraphs. Pass query to find a passage.]`;
		// Everything counted, separators too: a result over the budget is cut by the agent, and
		// the "transcript continues" line and the citing instruction are at the end.
		const budget = ctx.maxResultChars - head.length - 5 - tail.length - continues(paragraphs.length).length - 2;
		const lines: string[] = [];
		let chars = 0;
		let last = -2;
		for (const i of keep) {
			const p = paragraphs[i];
			const line = `[${formatTimestamp(p.start)}] ${p.text}`;
			const gap = last >= 0 && i !== last + 1 ? 3 : 0;
			if (lines.length > 0 && chars + gap + line.length + 2 > budget) {
				lines.push(continues(paragraphs.length - i));
				break;
			}
			if (gap) lines.push("…");
			lines.push(line);
			chars += gap + line.length + 2;
			last = i;
		}
		return `${head}\n---\n${lines.join("\n\n")}${tail}`;
	},
};

export const LECTURE_TOOLS: ToolDefinition[] = [listLectures, lectureTranscript];
