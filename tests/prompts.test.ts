import { describe, expect, it } from "vitest";
import { hasFrontmatter, reformatPrompt } from "../src/prompts";

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
