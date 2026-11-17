import { describe, expect, it } from "vitest";
import { QuizEngine, QuizSession, extractJson, isNonAnswer, noteDate, parseGrade, parseQuestions, parseQuizRequest, parseSince, questionMarkdown, renderReview, resultMarkdown, reviewNotePath, selectQuizNotes } from "../src/quiz";
import type { LectureInfo, NoteInfo } from "../src/types";
import { FakeOllama } from "./fakes";

// Wednesday 2026-11-18, noon local time.
const NOW = new Date(2026, 10, 18, 12, 0);

describe("parseSince", () => {
	it.each([
		["2026-10-01", "2026-10-01"],
		["2026-9-3", "2026-09-03"],
		["yesterday", "2026-11-17"],
		["today", "2026-11-18"],
		["last week", "2026-11-11"],
		["the last 2 weeks", "2026-11-04"],
		["3 days ago", "2026-11-15"],
		["last month", "2026-10-19"],
		["monday", "2026-11-16"],
		["last wednesday", "2026-11-11"],
		["Oct 3", "2026-10-03"],
		["October 3rd, 2025", "2025-10-03"],
		["December 1", "2025-12-01"],
		["10/3", "2026-10-03"],
	])("%s → %s", (phrase, expected) => {
		expect(parseSince(phrase, NOW)).toBe(expected);
	});

	it("is null for words that are not dates", () => {
		expect(parseSince("the beginning", NOW)).toBeNull();
	});
});

describe("parseQuizRequest", () => {
	it("reads the topic and the date", () => {
		expect(parseQuizRequest("Quiz me on CSCI 470 since October 1", NOW)).toEqual({ topic: "CSCI 470", since: "2026-10-01" });
		expect(parseQuizRequest("quiz me about my Machine Learning lectures from the last 2 weeks!", NOW)).toEqual({ topic: "Machine Learning", since: "2026-11-04" });
		expect(parseQuizRequest("Test me on thermodynamics last week", NOW)).toEqual({ topic: "thermodynamics", since: "2026-11-11" });
		expect(parseQuizRequest("Quiz me", NOW)).toEqual({ topic: "", since: undefined });
	});

	it("keeps a 'since' that is not a date in the topic, and ignores other messages", () => {
		expect(parseQuizRequest("quiz me on history since the war", NOW)).toEqual({ topic: "history since the war", since: undefined });
		expect(parseQuizRequest("What is a quiz?", NOW)).toBeNull();
	});
});

const note = (path: string, mtime = 0): NoteInfo => ({ path, basename: path.split("/").pop()!.replace(/\.md$/, ""), folder: "", mtime, ctime: 0, size: 1 });

describe("selectQuizNotes", () => {
	const notes = [note("Courses/CSCI 470/2026-09-25.md"), note("Courses/CSCI 470/2026-10-02.md"), note("Courses/HIST 210/2026-10-02.md"), note("Ideas/Thermo.md", new Date(2026, 10, 10).getTime())];
	const lectures: LectureInfo[] = [
		{ path: "Courses/CSCI 470/2026-10-02.md", course: "CSCI 470", date: "2026-10-02", kind: "lecture", sentence: null },
		{ path: "Courses/CSCI 470/2026-09-25.md", course: "CSCI 470", date: "2026-09-25", kind: "lecture", sentence: null },
	];

	it("uses Lecture Companion's lectures of the course since the date", () => {
		expect(selectQuizNotes(notes, { topic: "csci 470", since: "2026-10-01" }, lectures)).toEqual(["Courses/CSCI 470/2026-10-02.md"]);
		expect(selectQuizNotes(notes, { topic: "CSCI 470" }, lectures)).toEqual(["Courses/CSCI 470/2026-09-25.md", "Courses/CSCI 470/2026-10-02.md"]);
	});

	it("otherwise matches note paths, dated by name or modification", () => {
		expect(selectQuizNotes(notes, { topic: "hist 210" })).toEqual(["Courses/HIST 210/2026-10-02.md"]);
		expect(selectQuizNotes(notes, { topic: "thermo", since: "2026-11-01" })).toEqual(["Ideas/Thermo.md"]);
		expect(selectQuizNotes(notes, { topic: "thermo", since: "2026-11-15" })).toEqual([]);
		expect(selectQuizNotes(notes, { topic: "" })).toEqual([]);
		expect(noteDate(note("Daily/2026-01-14.md"))).toBe("2026-01-14");
	});
});

const LECTURE = "# 2026-10-02\n\n## Transcript\n\n**[12:05]** The contamination parameter defaults to 0.05, the expected share of outliers.\n\n**[14:00]** Isolation forests isolate anomalies with random splits.\n";

describe("questions and grades", () => {
	it("extracts JSON from chatter and fences", () => {
		expect(extractJson('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
		expect(extractJson("[1, 2]")).toEqual([1, 2]);
		expect(extractJson("no json")).toBeNull();
	});

	it("keeps checkable questions and cites the paragraph by heading", () => {
		const raw = JSON.stringify({
			questions: [
				{ question: "What does contamination default to?", answer: "0.05", source: "Courses/CSCI 470/2026-10-02", quote: "The contamination parameter defaults to 0.05" },
				{ question: "How do isolation forests isolate anomalies?", answer: "With random splits.", source: "2026-10-02.md", quote: "" },
				{ question: "Made up?", answer: "x", source: "Nowhere.md", quote: "not in any note" },
				{ question: "", answer: "missing question", source: "Courses/CSCI 470/2026-10-02.md" },
			],
		});
		const qs = parseQuestions(raw, [{ path: "Courses/CSCI 470/2026-10-02.md", content: LECTURE }]);
		expect(qs.map((q) => q.question)).toEqual(["What does contamination default to?", "How do isolation forests isolate anomalies?"]);
		expect(qs[0].cite).toBe("[[Courses/CSCI 470/2026-10-02#Transcript|2026-10-02 › 12:05]]");
		expect(qs[1].cite).toBe("[[Courses/CSCI 470/2026-10-02#Transcript|2026-10-02 › 14:00]]");
	});

	it("reads grades, and treats skips as wrong", () => {
		expect(parseGrade('{"verdict":"correct","feedback":"Yes."}')).toEqual({ verdict: "correct", feedback: "Yes." });
		expect(parseGrade('{"verdict":"Partially correct","feedback":"Half."}').verdict).toBe("partial");
		expect(parseGrade('{"verdict":"incorrect","feedback":"No."}').verdict).toBe("wrong");
		expect(parseGrade("That is correct.").verdict).toBe("correct");
		expect(isNonAnswer("skip")).toBe(true);
		expect(isNonAnswer("I don't know.")).toBe(true);
		expect(isNonAnswer("0.05")).toBe(false);
	});
});

describe("QuizSession and review note", () => {
	const q = (n: number) => ({ question: `Q${n}?`, answer: `A${n}`, source: "L.md", quote: "", cite: `[[L#T|L › ${n}:00]]` });

	it("asks in order, scores, and lists the missed ones", () => {
		const s = new QuizSession("ML", [q(1), q(2), q(3)]);
		expect(questionMarkdown(s)).toBe("**Question 1 of 3.** Q1?");
		s.record("A1", "correct", "Right.");
		const r = s.record("no idea", "wrong", "It is A2.");
		expect(resultMarkdown(r)).toBe("❌ **Not quite.** It is A2.\n\n**Answer:** A2 — [[L#T|L › 2:00]]");
		s.record("half", "partial", "");
		expect(s.done()).toBe(true);
		expect(s.score()).toBe("1 of 3 right (1 partly)");
		expect(s.missed().map((m) => m.question.question)).toEqual(["Q2?", "Q3?"]);
		expect(() => s.record("x", "correct", "")).toThrow(/over/);
	});

	it("writes a dated section without checkboxes, appending to an existing note", () => {
		const s = new QuizSession("CSCI 470", [q(1)]);
		s.record("wrong answer", "wrong", "Missed it.");
		const fresh = renderReview(null, "CSCI 470", "2026-11-18", s.missed());
		expect(fresh).toMatch(/^# Quiz review: CSCI 470\n/);
		expect(fresh).toContain("## 2026-11-18\n\n### Q1?\n- Your answer: wrong answer\n- Answer: A1 ([[L#T|L › 1:00]])\n- Note: Missed it.");
		expect(fresh).not.toMatch(/- \[ \]/);
		const appended = renderReview("# Quiz review: CSCI 470\n\nold\n", "CSCI 470", "2026-11-19", s.missed());
		expect(appended).toMatch(/old\n\n## 2026-11-19\n/);
		expect(reviewNotePath("Quiz reviews/", "CSCI 470: ML")).toBe("Quiz reviews/Quiz review - CSCI 470- ML.md");
	});
});

describe("QuizEngine", () => {
	it("asks for JSON questions with the notes in the prompt, then grades", async () => {
		const ollama = new FakeOllama([
			{ content: JSON.stringify({ questions: [{ question: "Default contamination?", answer: "0.05", source: "L.md", quote: "The contamination parameter defaults to 0.05" }] }) },
			{ content: '{"verdict": "correct", "feedback": "Exactly."}' },
		]);
		const engine = new QuizEngine(ollama.asClient(), () => ({ model: "m", numCtx: 8192, keepAlive: "1m" }));
		const qs = await engine.questions("ML", [{ path: "L.md", content: `---\ntags: x\n---\n${LECTURE}` }], 5);
		expect(qs).toHaveLength(1);
		const prompt = ollama.requests[0].messages[0].content;
		expect(prompt).toContain("--- L.md ---\n# 2026-10-02");
		expect(prompt).not.toContain("tags: x");
		expect(ollama.requests[0].format).toBe("json");
		expect(await engine.grade(qs[0], "0.05", LECTURE)).toEqual({ verdict: "correct", feedback: "Exactly." });
		expect(await engine.grade(qs[0], "skip", LECTURE)).toEqual({ verdict: "wrong", feedback: "No answer given." });
		expect(ollama.requests).toHaveLength(2);
	});
});
