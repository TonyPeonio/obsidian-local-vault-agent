import { describe, expect, it } from "vitest";
import { chunkMarkdown, splitSentences } from "../src/chunker";
import { SemanticIndex, type IndexData } from "../src/index";
import { FakeOllama, FakeVault } from "./fakes";

/**
 * A paragraph longer than one chunk (2,200 characters) that has no sentence ends: a long list
 * without full stops, a long line. It was cut every 2,200 characters, through the middle of a word.
 */

const MAX = 2200;
const words = (text: string) => text.split(/\s+/).filter(Boolean);

/** 2,198 characters of words, then "zeppelin" across the place the old cut fell, then more words. No sentence end anywhere. */
function longLine(): string {
	const head = "alpha ".repeat(400).slice(0, 2197) + " ";
	return head + "zeppelin " + "omega ".repeat(120).trim();
}

/** How a paragraph whose sentences all fit a chunk was cut before the change: sentences packed up to `max`, joined by one space. */
function packedSentences(para: string, max: number): string[] {
	const out: string[] = [];
	let current = "";
	for (const s of splitSentences(para)) {
		if (current && current.length + s.length + 1 > max) {
			out.push(current);
			current = s;
		} else current = current ? `${current} ${s}` : s;
	}
	if (current) out.push(current);
	return out;
}

describe("a paragraph longer than a chunk with no sentence ends", () => {
	it("is cut between words, and no word is lost", () => {
		const para = longLine();
		expect(para.slice(2198, 2206)).toBe("zeppelin");
		const chunks = chunkMarkdown(para);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX);
		expect(chunks.flatMap((c) => words(c.text))).toEqual(words(para));
		expect(chunks.filter((c) => /\bzeppelin\b/.test(c.text))).toHaveLength(1);
	});

	it("a long list without full stops is cut between its lines", () => {
		const lines = Array.from({ length: 150 }, (_, i) => `- part M-${String(i).padStart(3, "0")} stepper motor, NEMA 17, rated current 1.5 A`);
		const para = lines.join("\n");
		const chunks = chunkMarkdown(para);
		expect(chunks.length).toBeGreaterThan(2);
		for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX);
		expect(chunks.flatMap((c) => c.text.split("\n"))).toEqual(lines);
	});

	it("the word at the cut is not called absent from the vault", async () => {
		const vault = new FakeVault({ "Parts/Order.md": longLine(), "Recipes/Pasta.md": "Boil water, add pasta, stir." });
		const store = {
			data: null as IndexData | null,
			async load() {
				return this.data;
			},
			async save(d: IndexData) {
				this.data = d;
			},
		};
		const index = new SemanticIndex(new FakeOllama([]).asClient(), vault, store, { getModel: () => "nomic-embed-text", isEnabled: () => true, shouldIndex: () => true });
		await index.syncAll();
		// A passage search builds the word index, as the first question of a session does.
		await index.searchPassages("zeppelin", 3);
		expect(await index.absentWords("What did I order for the zeppelin?")).toEqual([]);
		// The check itself still works: a word that really is nowhere is named.
		expect(await index.absentWords("What did I order for the bulldozer?")).toEqual(["bulldozer"]);
	});

	it("a stretch with no whitespace at all is still cut every 2,200 characters, with nothing lost", () => {
		const para = "QUJD".repeat(1300);
		const chunks = chunkMarkdown(para);
		expect(chunks.map((c) => c.text.length)).toEqual([2200, 2200, 800]);
		expect(chunks.map((c) => c.text).join("")).toBe(para);
	});

	it("such a stretch is never cut between the two halves of one character", () => {
		const para = "a" + "\u{1F600}".repeat(1500);
		const chunks = chunkMarkdown(para);
		expect(chunks.map((c) => c.text).join("")).toBe(para);
		// A lone half of a pair makes this throw.
		for (const c of chunks) expect(() => encodeURIComponent(c.text)).not.toThrow();
	});

	it("words before a stretch with no whitespace stay whole too", () => {
		const para = "see the attached key " + "QUJD".repeat(1000);
		const chunks = chunkMarkdown(para);
		expect(chunks[0].text).toBe("see the attached key");
		expect(chunks.slice(1).map((c) => c.text).join("")).toBe("QUJD".repeat(1000));
	});
});

describe("what the change must not touch", () => {
	it("a paragraph that fits one chunk is one chunk, as it is", () => {
		const para = "alpha ".repeat(360).trim();
		expect(para.length).toBeLessThanOrEqual(MAX);
		expect(chunkMarkdown(para).map((c) => c.text)).toEqual([para]);
	});

	it("a long paragraph of ordinary sentences is cut at its sentence ends exactly as before", () => {
		const para = Array.from({ length: 220 }, (_, i) => `Sentence number ${i} says something about the gantry.`).join(" ");
		const expected = packedSentences(para, MAX);
		expect(expected.length).toBeGreaterThan(3);
		expect(chunkMarkdown(para).map((c) => c.text)).toEqual(expected);
	});

	it("a list whose lines end in full stops is cut at those sentence ends exactly as before", () => {
		const para = Array.from({ length: 120 }, (_, i) => `- Item ${i}: tighten the belt and check the pulley.`).join("\n");
		expect(chunkMarkdown(para).map((c) => c.text)).toEqual(packedSentences(para, MAX));
	});
});
