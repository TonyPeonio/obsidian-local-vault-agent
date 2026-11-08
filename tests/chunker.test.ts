import { describe, expect, it } from "vitest";
import { chunkMarkdown, splitSentences, stripFrontmatter } from "../src/chunker";

describe("splitSentences", () => {
	it("splits on terminal punctuation followed by whitespace", () => {
		expect(splitSentences("One. Two! Three? Four")).toEqual(["One.", "Two!", "Three?", "Four"]);
	});
	it("keeps decimals and abbreviations without trailing space together", () => {
		expect(splitSentences("Version 1.5 is out. Done.")).toEqual(["Version 1.5 is out.", "Done."]);
	});
	it("handles text with no punctuation", () => {
		expect(splitSentences("no punctuation here")).toEqual(["no punctuation here"]);
	});
});

describe("stripFrontmatter", () => {
	it("removes a YAML block", () => {
		const r = stripFrontmatter("---\ntags: [a]\n---\n# Hi\nbody");
		expect(r.frontmatter).toBe("tags: [a]");
		expect(r.body).toBe("# Hi\nbody");
	});
	it("leaves notes without frontmatter alone", () => {
		expect(stripFrontmatter("# Hi\n---\nnot frontmatter").body).toBe("# Hi\n---\nnot frontmatter");
	});
});

describe("chunkMarkdown", () => {
	it("splits on headings and records the heading", () => {
		const chunks = chunkMarkdown("intro\n\n# One\n\nfirst\n\n## Two\n\nsecond");
		expect(chunks.map((c) => c.heading)).toEqual(["", "One", "Two"]);
		expect(chunks[1].text).toBe("first");
	});

	it("keeps transcript timestamp markers verbatim (Lecture Companion's `**[m:ss]**` paragraphs)", () => {
		const paragraphs = ["**[3:04]** Okay, let's get started.", "**[21:29]** In the demo I set contamination to 0.05.", "**[30:56]** Any questions on that?"];
		const chunks = chunkMarkdown(`## 2026-11-04\n\n### Summary\n\n- a bullet [21:29]\n\n### Transcript\n\n${paragraphs.join("\n\n")}\n`);
		const transcript = chunks.filter((c) => c.heading === "Transcript");
		expect(transcript).toHaveLength(1);
		expect(transcript[0].text).toBe(paragraphs.join("\n\n"));
		expect(chunks.find((c) => c.heading === "Summary")?.text).toBe("- a bullet [21:29]");
	});

	it("ignores '#' lines inside code fences", () => {
		const chunks = chunkMarkdown("# Real\n\n```sh\n# not a heading\necho hi\n```\n");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].heading).toBe("Real");
		expect(chunks[0].text).toContain("# not a heading");
	});

	it("packs paragraphs up to the target size", () => {
		const para = "word ".repeat(60).trim(); // ~300 chars
		const content = Array(10).fill(para).join("\n\n");
		const chunks = chunkMarkdown(content, { target: 1000, max: 2000 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1000);
	});

	it("splits a single huge paragraph on sentence boundaries", () => {
		const sentence = "This is a sentence that goes on for a while. ";
		const content = sentence.repeat(100);
		const chunks = chunkMarkdown(content, { target: 500, max: 600 });
		for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(600);
		expect(chunks.map((c) => c.text).join(" ")).toContain("This is a sentence");
		expect(chunks.length).toBeGreaterThan(5);
	});

	it("returns nothing for an empty note", () => {
		expect(chunkMarkdown("---\ntitle: x\n---\n")).toEqual([]);
	});
});
