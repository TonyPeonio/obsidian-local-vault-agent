import { describe, expect, it } from "vitest";
import { editSelectionPrompt, hasFrontmatter, processDailyNotesPrompt, reformatPrompt } from "../src/prompts";

describe("processDailyNotesPrompt", () => {
	it("spells out the survey grep, the destination, the sources section and the move step", () => {
		const p = processDailyNotesPrompt({ folder: "Daily", heading: "Capture", destination: "Topics", move: true, since: "2026-08-01" });
		expect(p).toContain('list_sections with heading "Capture" and folder "Daily", limit 400');
		expect(p).toContain('read_section (path, "Capture")');
		expect(p).toContain('"Topics/<Subject>.md"');
		expect(p).toContain("[[Daily/2026-09-21]]");
		expect(p).toContain('replace_section with the daily note\'s path, heading "Capture" and new_text "- Moved to [[Topics/<Subject>]]"');
		expect(p).toContain("on or after 2026-08-01");
		expect(p).toContain('"Topics/Code snippets.md"');
	});
	it("handles the vault root, a '#'-prefixed heading and no moving", () => {
		const p = processDailyNotesPrompt({ folder: "", heading: "## Inbox", destination: "", move: false });
		expect(p).toContain("live in the vault root");
		expect(p).toContain('list_sections with heading "Inbox", limit 400');
		expect(p).toContain('"<Subject>.md"');
		expect(p).toContain("4. Leave the daily notes unchanged.");
		expect(p).not.toContain("replace_section");
	});
});

describe("editSelectionPrompt", () => {
	it("quotes the selection and asks for one edit_note call with it as old_text", () => {
		const p = editSelectionPrompt("Notes/A.md", "line one\nline two", "is a table.");
		expect(p).toContain('In the note "Notes/A.md", rewrite the selected passage below so that it is a table.');
		expect(p).toContain('Call edit_note once with path "Notes/A.md"');
		expect(p).toContain('"""\nline one\nline two\n"""');
	});
});

describe("hasFrontmatter", () => {
	it("detects a leading YAML block", () => {
		expect(hasFrontmatter("---\ntags: [a]\n---\nbody")).toBe(true);
		expect(hasFrontmatter("---\r\ntags: [a]\r\n---\r\nbody")).toBe(true);
		expect(hasFrontmatter("---\nonly: this\n---")).toBe(true);
	});
	it("is false for a horizontal rule or no block", () => {
		expect(hasFrontmatter("text\n---\nmore")).toBe(false);
		expect(hasFrontmatter("# Title")).toBe(false);
		expect(hasFrontmatter("---\nunterminated")).toBe(false);
	});
});

describe("reformatPrompt", () => {
	it("tells the model whether to keep or avoid frontmatter", () => {
		expect(reformatPrompt("A.md", "---\nx: 1\n---\nbody")).toContain("Keep the YAML frontmatter");
		expect(reformatPrompt("A.md", "body")).toContain("do not add one");
		expect(reformatPrompt("A.md", "body")).toContain('"A.md"');
	});
});
