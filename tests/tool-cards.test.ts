import { describe, expect, it } from "vitest";
import { LECTURE_TOOLS } from "../src/lecture-companion";
import { describeCall, describeResult, iconFor } from "../src/tool-cards";
import { ALL_TOOLS } from "../src/tools";
import type { ToolCall } from "../src/types";
import { readImage } from "../src/vision";

const EVERY_TOOL = [...ALL_TOOLS, ...LECTURE_TOOLS, readImage];
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ function: { name, arguments: args } });

describe("tool cards", () => {
	it("gives every tool the agent can be offered its own icon", () => {
		expect(EVERY_TOOL.length).toBe(23);
		for (const tool of EVERY_TOOL) {
			const { icon, fallback } = iconFor(tool.name);
			expect(icon, tool.name).not.toBe("wrench");
			expect(fallback, tool.name).toBeTruthy();
			// A read-only tool never shows the pencil, which means "this wrote to a note".
			if (!tool.mutates) {
				expect(icon, tool.name).not.toBe("pencil");
				expect(fallback, tool.name).not.toBe("pencil");
			}
		}
	});

	it("shows an unknown tool as a tool, and as a write only when its name says so", () => {
		expect(iconFor("web_lookup").icon).toBe("wrench");
		expect(iconFor("rename_tag").icon).toBe("pencil");
	});

	it("has a sentence for every tool, never the raw tool name", () => {
		for (const tool of EVERY_TOOL) {
			const text = describeCall(call(tool.name, { path: "Notes/A.md", query: "q", pattern: "p", heading: "H", new_path: "B.md" }));
			expect(text, tool.name).not.toContain(tool.name);
			expect(text, tool.name).not.toContain("_");
			expect(text[0], tool.name).toBe(text[0].toUpperCase());
		}
	});

	it("describes the four calls that used to show as raw names", () => {
		expect(describeCall(call("replace_section", { path: "Daily/2026-11-03.md", heading: "Capture", new_text: "" }))).toBe("Replaced the section Daily/2026-11-03 › Capture");
		expect(describeCall(call("read_image", { path: "Attachments/board.png" }))).toBe("Looked at the image Attachments/board.png");
		expect(describeCall(call("read_image", { path: "Scans/hw.pdf", page: 3, question: "what is the total?" }))).toBe("Looked at the image Scans/hw.pdf (page 3) for “what is the total?”");
		expect(describeCall(call("list_lectures"))).toBe("Listed lectures");
		expect(describeCall(call("list_lectures", { course: "ML", since: "2026-10-01", contains: "isolation forest" }))).toBe("Listed lectures in ML since 2026-10-01 mentioning “isolation forest”");
		expect(describeCall(call("list_lectures", { since: "2026-10-01", until: "2026-10-31" }))).toBe("Listed lectures from 2026-10-01 to 2026-10-31");
		expect(describeCall(call("lecture_transcript", { path: "Lectures/ML 2026-11-03.md" }))).toBe("Read the transcript of Lectures/ML 2026-11-03");
		expect(describeCall(call("lecture_transcript", { path: "Lectures/ML 2026-11-03.md", query: "contamination" }))).toBe("Searched the transcript of Lectures/ML 2026-11-03 for “contamination”");
	});

	it("keeps the existing sentences and says what list_sections was asked", () => {
		expect(describeCall(call("search_notes", { query: "magnet problems" }))).toBe("Searched notes for “magnet problems”");
		expect(describeCall(call("read_section", { path: "A.md", heading: "Summary" }))).toBe("Read A › Summary");
		expect(describeCall(call("list_sections", { containing: ["![[Recording", "### Summary"] }))).toBe("Checked sections for “![[Recording” / “### Summary”");
		expect(describeCall(call("list_sections", { heading: "Capture", folder: "Daily" }))).toBe("Listed sections headed “Capture” in Daily");
		expect(describeCall(call("mystery_tool"))).toBe("Mystery tool");
		expect(describeCall({ function: { name: "edit_notes", arguments: undefined as unknown as Record<string, unknown> } })).toBe("Applied 0 edits across notes");
	});

	it("summarises what the lecture and image tools returned", () => {
		expect(describeResult(call("list_lectures"), "3 lectures in ML. Courses: ML, Stats.\n2026-11-03 · ML · lecture · L.md")).toBe("3 lectures");
		expect(describeResult(call("list_lectures"), "1 lecture. Courses: ML.\n…")).toBe("1 lecture");
		expect(describeResult(call("lecture_transcript"), "# L.md (transcript, ML, 2026-11-03, 40 paragraphs)\n---\n[0:05] Hello.\n\n[12:40] Isolation forests.\n\n[1:02:03] Done.\n---\nQuote the paragraph")).toBe("3 paragraphs");
		expect(describeResult(call("lecture_transcript"), '# L.md (transcript, 40 paragraphs)\nNo paragraph mentions "x". Try other words')).toBe("no match");
		expect(describeResult(call("lecture_transcript"), "L.md has no transcript.")).toBe("no match");
		expect(describeResult(call("read_image"), "# Attachments/board.png\n---\nA whiteboard with three boxes.")).toBe("30 chars");
		expect(describeResult(call("grep_vault"), "4 matching lines in 2 notes:\n…")).toBe("4 lines in 2 notes");
	});
});
