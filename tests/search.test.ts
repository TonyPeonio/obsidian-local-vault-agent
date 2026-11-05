import { describe, expect, it } from "vitest";
import { fuseRankings, keywordSearch, makeSnippet, queryTerms, tokenize } from "../src/search";
import { FakeVault } from "./fakes";

const vault = new FakeVault({
	"Projects/Chess Robot.md": "# Chess Robot\nThe gantry moves pieces with an electromagnet. Hall sensors detect pieces.",
	"Daily/2026-01-01.md": "Worked on the chess robot gantry calibration. Also groceries.",
	"Recipes/Pasta.md": "Boil water, add pasta, stir. Serve with sauce.",
	"Ideas/Sensors.md": "Hall effect sensors are cheap. Could use 96 of them on a board.",
});

describe("tokenize / queryTerms", () => {
	it("drops stop words and keeps meaningful terms", () => {
		expect(queryTerms("what are my notes about the chess robot?")).toEqual(["chess", "robot"]);
	});
	it("falls back to all tokens when everything is a stop word", () => {
		expect(queryTerms("what is it")).toEqual(tokenize("what is it"));
	});
	it("keeps tags and hyphenated words", () => {
		expect(tokenize("#hall-sensor stuff")).toEqual(["hall-sensor", "stuff"]);
	});
});

describe("keywordSearch", () => {
	it("ranks title matches and multi-term matches first", async () => {
		const hits = await keywordSearch(vault, "chess robot", 10);
		expect(hits[0].path).toBe("Projects/Chess Robot.md");
		expect(hits.map((h) => h.path)).toContain("Daily/2026-01-01.md");
		expect(hits.map((h) => h.path)).not.toContain("Recipes/Pasta.md");
	});

	it("finds content-only matches", async () => {
		const hits = await keywordSearch(vault, "hall sensors", 10);
		expect(hits.map((h) => h.path)).toEqual(
			expect.arrayContaining(["Projects/Chess Robot.md", "Ideas/Sensors.md"]),
		);
	});

	it("respects the limit", async () => {
		const hits = await keywordSearch(vault, "sensors", 1);
		expect(hits).toHaveLength(1);
	});
});

describe("makeSnippet", () => {
	it("centres on the first matching term and marks truncation", () => {
		const text = "x".repeat(500) + " needle " + "y".repeat(500);
		const s = makeSnippet(text, ["needle"], 100);
		expect(s).toContain("needle");
		expect(s.startsWith("…")).toBe(true);
		expect(s.endsWith("…")).toBe(true);
		expect(s.length).toBeLessThanOrEqual(102);
	});
});

describe("fuseRankings", () => {
	it("boosts paths present in both lists", () => {
		const a = [{ path: "x", score: 1, snippet: "a" }, { path: "y", score: 0.9, snippet: "" }];
		const b = [{ path: "z", score: 1, snippet: "b" }, { path: "y", score: 0.5, snippet: "y-snip" }];
		const fused = fuseRankings([a, b], 10);
		expect(fused[0].path).toBe("y");
		expect(fused.find((h) => h.path === "y")?.snippet).toBe("y-snip");
		expect(fused).toHaveLength(3);
	});
});
