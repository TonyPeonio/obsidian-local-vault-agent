import { describe, expect, it } from "vitest";
import { LexicalIndex, fuseKeyed, lexQueryTerms, lexTokens, stem } from "../src/retrieval";

describe("stem", () => {
	it("folds plurals and leaves names, short words and code alone", () => {
		expect(stem("sensors")).toBe("sensor");
		expect(stem("libraries")).toBe("library");
		expect(stem("classes")).toBe("class");
		expect(stem("class")).toBe("class");
		expect(stem("status")).toBe("status");
		expect(stem("analysis")).toBe("analysis");
		expect(stem("gas")).toBe("gas");
		expect(stem("a3144")).toBe("a3144");
		expect(stem("lrs-350-24")).toBe("lrs-350-24");
	});

	it("gives a question and a note the same terms", () => {
		expect(lexQueryTerms("How are the hall sensors polled?")).toEqual(["hall", "sensor", "polled"]);
		expect(lexTokens("Hall sensor polling: sensors at 50 Hz")).toContain("sensor");
	});
});

describe("LexicalIndex", () => {
	const build = () => {
		const lex = new LexicalIndex();
		lex.setFile("Projects/Chess Robot.md", [
			{ heading: "Decisions", text: "Switch the gantry supply from 12V to 24V after repeated brownouts. Ordered the Mean Well LRS-350-24." },
			{ heading: "Log", text: "Built the frame. First full move sequence. The gantry homes against the limit switches." },
		], "Chess Robot");
		lex.setFile("Projects/Hall Sensors.md", [
			{ heading: "Lessons", text: "A3144 digital hall sensors under each square, read at 50 Hz. Debounce for 3 samples." },
		], "Hall Sensors");
		lex.setFile("Daily/2026-06-12.md", [{ heading: "Capture", text: "salloc -N 1 -t 02:00:00 then module load the gantry code" }], "2026-06-12");
		return lex;
	};

	it("ranks the chunk with the rare term first and reports coverage", () => {
		const hits = build().search("LRS-350-24 power supply", 5);
		expect(hits[0]).toMatchObject({ path: "Projects/Chess Robot.md", idx: 0 });
		expect(hits[0].matched).toBeGreaterThanOrEqual(2);
		expect(hits[0].terms).toBe(3);
	});

	it("finds an identifier an embedding would blur", () => {
		expect(build().search("A3144", 3)[0].path).toBe("Projects/Hall Sensors.md");
		expect(build().search("salloc", 3)[0].path).toBe("Daily/2026-06-12.md");
	});

	it("matches whole words only", () => {
		// "art" must not match "start"; the old keyword scorer counted substrings.
		const lex = new LexicalIndex();
		lex.setFile("a.md", [{ heading: "", text: "start the restart" }]);
		lex.setFile("b.md", [{ heading: "", text: "modern art" }]);
		expect(lex.search("art", 5).map((h) => h.path)).toEqual(["b.md"]);
	});

	it("weighs the heading and the note title above body text", () => {
		const lex = new LexicalIndex();
		lex.setFile("x.md", [{ heading: "Dijkstra", text: "The shortest path algorithm with a heap." }], "Lectures");
		lex.setFile("y.md", [{ heading: "Graphs", text: "We mentioned dijkstra once among many other words about graphs and trees and heaps." }], "Lectures");
		expect(lex.search("dijkstra", 2)[0].path).toBe("x.md");
	});

	it("prefers a chunk with every term over one that repeats a single term", () => {
		const lex = new LexicalIndex();
		lex.setFile("one.md", [{ heading: "", text: "gantry gantry gantry gantry gantry gantry" }]);
		lex.setFile("both.md", [{ heading: "", text: "the gantry supply voltage" }]);
		lex.setFile("pad.md", [{ heading: "", text: "nothing relevant here at all" }]);
		expect(lex.search("gantry voltage", 2)[0].path).toBe("both.md");
	});

	it("doubles a chunk that contains the question as a phrase", () => {
		const lex = new LexicalIndex();
		const texts: Record<string, string> = { "a.md": "repeated brownouts during fast moves", "b.md": "brownouts were repeated, and moves were fast, fast, fast; brownouts brownouts" };
		for (const [p, t] of Object.entries(texts)) lex.setFile(p, [{ heading: "", text: t }]);
		expect(lex.search("repeated brownouts", 2, (p) => texts[p])[0].path).toBe("a.md");
	});

	it("forgets removed notes, follows renames, and replaces a note's chunks", () => {
		const lex = build();
		expect(lex.size).toBe(4);
		lex.remove("Projects/Hall Sensors.md");
		expect(lex.search("A3144", 3)).toEqual([]);
		lex.rename("Daily/2026-06-12.md", "Daily/moved.md");
		expect(lex.search("salloc", 3)[0].path).toBe("Daily/moved.md");
		lex.setFile("Projects/Chess Robot.md", [{ heading: "", text: "now about pawns" }], "Chess Robot");
		expect(lex.search("brownouts", 3)).toEqual([]);
		expect(lex.search("pawns", 3)[0]).toMatchObject({ path: "Projects/Chess Robot.md", idx: 0 });
		expect(lex.size).toBe(2);
	});

	it("stays correct after many replacements force a compaction", () => {
		const lex = new LexicalIndex();
		for (let round = 0; round < 4; round++) {
			for (let i = 0; i < 600; i++) lex.setFile(`n${i}.md`, [{ heading: "", text: `note ${i} round ${round} marker${i}` }]);
		}
		expect(lex.size).toBe(600);
		const hit = lex.search("marker421", 3);
		expect(hit).toHaveLength(1);
		expect(hit[0].path).toBe("n421.md");
		lex.rename("n421.md", "renamed.md");
		expect(lex.search("marker421", 3)[0].path).toBe("renamed.md");
	});

	it("returns nothing for a question made only of unknown words or an empty index", () => {
		expect(build().search("zzzz qqqq", 5)).toEqual([]);
		expect(new LexicalIndex().search("gantry", 5)).toEqual([]);
		expect(build().search("", 5)).toEqual([]);
	});
});

describe("fuseKeyed", () => {
	it("puts an entry both lists agree on above the top of either", () => {
		const a = ["x", "shared", "y"].map((key) => ({ key, item: key }));
		const b = ["z", "shared", "w"].map((key) => ({ key, item: key }));
		const out = fuseKeyed([a, b], 3);
		expect(out[0].item).toBe("shared");
		expect(out[0].ranks).toEqual([1, 1]);
		expect(out[1].ranks.filter((r) => r !== undefined)).toHaveLength(1);
	});

	it("counts a key once per list and honours the limit", () => {
		const a = ["x", "x", "y"].map((key) => ({ key, item: key }));
		const out = fuseKeyed([a], 5);
		expect(out.map((o) => o.item)).toEqual(["x", "y"]);
		expect(fuseKeyed([a], 1)).toHaveLength(1);
	});
});
