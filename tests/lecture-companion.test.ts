import { describe, expect, it } from "vitest";
import { Agent, newConversation, type AgentConfig } from "../src/agent";
import { LECTURE_TOOLS, findLecture, formatTimestamp, lectureCompanionApi, lectureTranscript, listLectures, matchParagraphs } from "../src/lecture-companion";
import { keywordSearch } from "../src/search";
import { ALL_TOOLS } from "../src/tools";
import type { LectureInfo, LectureSource, ToolContext } from "../src/types";
import { FakeOllama, FakeVault } from "./fakes";

const LECTURES: LectureInfo[] = [
	{ path: "Courses/CSCI 470/2026-10-02.md", course: "CSCI 470", date: "2026-10-02", kind: "lecture", sentence: "Isolation forests and contamination." },
	{ path: "Courses/CSCI 470/2026-09-25.md", course: "CSCI 470", date: "2026-09-25", kind: "lecture", sentence: "Decision trees." },
	{ path: "Courses/HIST 210/2026-10-02.md", course: "HIST 210", date: "2026-10-02", kind: "lecture", sentence: null },
	{ path: "Meetings/Lab/2026-10-05.md", course: "Lab", date: "2026-10-05", kind: "meeting", sentence: "Robot arm budget." },
];

const TRANSCRIPT = [
	{ start: 5, text: "Welcome back everyone." },
	{ start: 190, text: "Each tree splits on a random feature." },
	{ start: 725, text: "The contamination parameter defaults to 0.05 in scikit-learn." },
	{ start: 820, text: "Homework is due Friday." },
];

function source(): LectureSource {
	return {
		courses: () => ["CSCI 470", "HIST 210", "Lab"],
		lectures: (course?: string) => (course ? LECTURES.filter((l) => l.course === course) : LECTURES),
		transcript: async (path: string) => (path === LECTURES[0].path ? TRANSCRIPT : []),
	};
}

function ctx(vault: FakeVault, lectures?: LectureSource): ToolContext {
	return { vault, search: async () => [], approve: async () => "approve", maxResultChars: 4000, lectures };
}

describe("lectureCompanionApi", () => {
	const api = { version: 1, courses: () => [], lectures: () => [], transcript: async () => [], transcribe: async () => "", ollama: () => ({ url: "u", model: "m" }) };
	it("returns the API from the plugin registry when it is version 1 and complete", () => {
		expect(lectureCompanionApi({ plugins: { plugins: { "lecture-companion": { api } } } })).toBe(api);
	});
	it("is null when missing, another version, or incomplete", () => {
		expect(lectureCompanionApi({})).toBeNull();
		expect(lectureCompanionApi(null)).toBeNull();
		expect(lectureCompanionApi({ plugins: { plugins: { "lecture-companion": { api: { ...api, version: 2 } } } } })).toBeNull();
		expect(lectureCompanionApi({ plugins: { plugins: { "lecture-companion": { api: { ...api, transcribe: undefined } } } } })).toBeNull();
	});
});

describe("helpers", () => {
	it("formats timestamps like Lecture Companion", () => {
		expect(formatTimestamp(5)).toBe("0:05");
		expect(formatTimestamp(725)).toBe("12:05");
		expect(formatTimestamp(3723)).toBe("1:02:03");
	});

	it("ranks paragraphs by query terms", () => {
		expect(matchParagraphs(TRANSCRIPT, "what did the professor say about contamination?").map((m) => m.index)).toEqual([2]);
		expect(matchParagraphs(TRANSCRIPT, "", 2).map((m) => m.index)).toEqual([0, 1]);
		expect(matchParagraphs(TRANSCRIPT, "quantum chromodynamics")).toEqual([]);
	});

	it("finds a lecture by path, name or course and date", () => {
		const vault = new FakeVault({ "Courses/CSCI 470/2026-10-02.md": "x" });
		expect(findLecture(LECTURES, vault, "[[Courses/CSCI 470/2026-10-02]]")?.course).toBe("CSCI 470");
		expect(findLecture(LECTURES, vault, "HIST 210 2026-10-02")?.course).toBe("HIST 210");
		expect(findLecture(LECTURES, vault, "2026-09-25")?.sentence).toBe("Decision trees.");
		expect(findLecture(LECTURES, vault, "2026-12-01")).toBeNull();
	});
});

describe("list_lectures", () => {
	it("lists by course and date range with summaries", async () => {
		const out = await listLectures.execute({ course: "csci", since: "2026-10-01" }, ctx(new FakeVault(), source()));
		expect(out).toMatch(/^1 lecture in csci/);
		expect(out).toContain("2026-10-02 · CSCI 470 · lecture · Courses/CSCI 470/2026-10-02.md — Isolation forests and contamination.");
		expect(out).not.toContain("2026-09-25");
	});

	it("filters by words in the summary, and explains without Lecture Companion", async () => {
		const out = await listLectures.execute({ contains: "budget" }, ctx(new FakeVault(), source()));
		expect(out).toContain("Meetings/Lab/2026-10-05.md");
		expect(out).not.toContain("· CSCI");
		await expect(listLectures.execute({}, ctx(new FakeVault()))).rejects.toThrow(/not installed/);
	});
});

describe("lecture_transcript", () => {
	it("returns the matching paragraphs with neighbours and their [m:ss]", async () => {
		const vault = new FakeVault({ "Courses/CSCI 470/2026-10-02.md": "x" });
		const out = await lectureTranscript.execute({ path: "CSCI 470 2026-10-02", query: "contamination" }, ctx(vault, source()));
		expect(out).toMatch(/^# Courses\/CSCI 470\/2026-10-02\.md \(transcript, CSCI 470, 2026-10-02, 4 paragraphs/);
		expect(out).toContain("[12:05] The contamination parameter defaults to 0.05");
		expect(out).toContain("[3:10] Each tree");
		expect(out).toContain("[13:40] Homework");
		expect(out).not.toContain("[0:05]");
		expect(out).toContain("cite [[Courses/CSCI 470/2026-10-02]]");
	});

	it("returns the whole transcript without a query, and says when nothing matches", async () => {
		const vault = new FakeVault({ "Courses/CSCI 470/2026-10-02.md": "x" });
		const all = await lectureTranscript.execute({ path: "Courses/CSCI 470/2026-10-02.md" }, ctx(vault, source()));
		expect(all).toContain("[0:05] Welcome");
		const none = await lectureTranscript.execute({ path: "Courses/CSCI 470/2026-10-02.md", query: "gradient boosting" }, ctx(vault, source()));
		expect(none).toContain('No paragraph mentions "gradient boosting"');
		await expect(lectureTranscript.execute({ path: "nowhere" }, ctx(vault, source()))).rejects.toThrow(/No lecture found/);
	});

	it("keeps a long transcript, its 'continues' line and the citing instruction within the result budget", async () => {
		const vault = new FakeVault({ "Courses/CSCI 470/2026-10-02.md": "x" });
		// Many short paragraphs: the separators between them are what used to push the result over.
		const long = Array.from({ length: 600 }, (_, i) => ({ start: i * 7, text: `short one ${i}` }));
		const src: LectureSource = { ...source(), transcript: async () => long };
		const out = await lectureTranscript.execute({ path: "Courses/CSCI 470/2026-10-02.md" }, ctx(vault, src));
		expect(out.length).toBeLessThanOrEqual(4000);
		const shown = (out.match(/^\[\d+:\d\d\] short one \d+$/gm) ?? []).length;
		expect(shown).toBeGreaterThan(100);
		expect(out).toContain(`\n\n[… transcript continues; ${600 - shown} more paragraphs. Pass query to find a passage.]\n---\nQuote the paragraph you use with its [m:ss] time and cite [[Courses/CSCI 470/2026-10-02]].`);
	});
});

describe("list_lectures within the result budget", () => {
	it("says how many lectures are not shown when the rows do not fit", async () => {
		const many: LectureInfo[] = Array.from({ length: 150 }, (_, i) => ({ path: `Courses/CSCI 470/Lecture ${String(i).padStart(3, "0")}.md`, course: "CSCI 470", date: `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`, kind: "lecture", sentence: "A one-sentence summary of what the lecture covered." }));
		const src: LectureSource = { ...source(), lectures: () => many };
		const out = await listLectures.execute({}, ctx(new FakeVault(), src));
		expect(out.length).toBeLessThanOrEqual(4000);
		const rows = (out.match(/ · CSCI 470 · lecture · /g) ?? []).length;
		expect(rows).toBeGreaterThan(20);
		expect(out.endsWith(`\n… ${150 - rows} more; narrow with course or since/until.`)).toBe(true);
	});
});

describe("agent with Lecture Companion", () => {
	const config: AgentConfig = { model: "fake", numCtx: 8192, temperature: 0, keepAlive: "1m", maxIterations: 6, maxToolResultChars: 4000, autoApprove: true, autoContinue: false, extraSystemPrompt: "", citations: "headings" };

	it("offers the lecture tools only when Lecture Companion is present, and cites the transcript", async () => {
		const note = "# 2026-10-02\n\n## Transcript\n\n**[12:05]** The contamination parameter defaults to 0.05 in scikit-learn.\n";
		const vault = new FakeVault({ "Courses/CSCI 470/2026-10-02.md": note });
		let present = true;
		const ollama = new FakeOllama([
			{ tool: "lecture_transcript", args: { path: "Courses/CSCI 470/2026-10-02.md", query: "contamination" } },
			{ content: "At 12:05 the professor said the contamination parameter defaults to 0.05 ([[Courses/CSCI 470/2026-10-02]])." },
			{ content: "No lectures here." },
		]);
		const agent = new Agent({
			client: ollama.asClient(),
			vault,
			tools: ALL_TOOLS,
			search: (q, l) => keywordSearch(vault, q, l),
			approve: async () => "approve",
			getConfig: () => config,
			extraTools: () => (present ? LECTURE_TOOLS : []),
			lectures: () => (present ? source() : undefined),
		});
		let final = "";
		await agent.run(newConversation(), "When did the professor talk about contamination?", { onAssistantDone: (m) => (final = m.content) });
		expect(ollama.requests[0].tools?.map((t) => t.function.name)).toContain("lecture_transcript");
		expect(final).toContain("Passages: [[Courses/CSCI 470/2026-10-02#Transcript|2026-10-02 › 12:05]]");
		present = false;
		await agent.run(newConversation(), "Anything?", {});
		expect(ollama.requests[2].tools?.map((t) => t.function.name)).not.toContain("lecture_transcript");
	});
});
