import { describe, expect, it } from "vitest";
import { chunkMarkdown, splitSentences, stripFrontmatter, tableStart } from "../src/chunker";

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

describe("a table too long for one chunk", () => {
	const head = "| Part | Frame | Rated current | Holding torque | Notes |\n|---|---|---|---|---|";
	const row = (i: number) => `| M-${100 + i} | NEMA ${[14, 17, 23][i % 3]} | ${(0.4 + i * 0.05).toFixed(2)} A | ${12 + (i % 4) * 4} N·cm | ${i === 62 ? "used on the gantry Y axis" : ""} |`;
	const rows = Array.from({ length: 90 }, (_, i) => row(i));
	const note = `# Motors\n\nMeasured in October.\n\n${head}\n${rows.join("\n")}\n\nQuotes are in the shared folder.\n`;

	it("is cut between rows, never inside one, and every piece has the heading row", () => {
		const tables = chunkMarkdown(note).filter((c) => c.text.includes("| M-"));
		expect(tables.length).toBeGreaterThan(1);
		const seen: string[] = [];
		for (const c of tables) {
			const lines = c.text.split("\n").filter((l) => l.startsWith("|"));
			expect(lines.slice(0, 2).join("\n")).toBe(head);
			expect(c.text.length).toBeLessThanOrEqual(2200);
			for (const l of lines.slice(2)) {
				expect(rows).toContain(l); // a whole row, as written
				seen.push(l);
			}
		}
		// Every row once, in order.
		expect(seen).toEqual(rows);
	});

	it("keeps a table that fits in one chunk as it is, and text without a table is cut as before", () => {
		const small = `${head}\n${rows.slice(0, 30).join("\n")}`;
		expect(chunkMarkdown(small).map((c) => c.text)).toEqual([small]);
		const prose = "A sentence that is not in a table at all. ".repeat(80).trim();
		expect(chunkMarkdown(prose).every((c) => !c.text.includes("|---|"))).toBe(true);
		expect(chunkMarkdown(prose).length).toBeGreaterThan(1);
	});

	it("handles a table without outer bars and text in the same paragraph", () => {
		const bare = `Caption line\nPart | Value\n--- | ---\n${Array.from({ length: 300 }, (_, i) => `P-${i} | ${i * 3} mm`).join("\n")}\nA closing line right under the table.`;
		const chunks = chunkMarkdown(bare);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0].text.startsWith("Caption line\nPart | Value\n--- | ---\nP-0 | 0 mm")).toBe(true);
		for (const c of chunks.slice(1)) expect(c.text.startsWith("Part | Value\n--- | ---\nP-")).toBe(true);
		expect(chunks.at(-1)?.text.endsWith("P-299 | 897 mm\nA closing line right under the table.")).toBe(true);
		expect(tableStart(["no table here", "--- just a rule"])).toBe(-1);
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
