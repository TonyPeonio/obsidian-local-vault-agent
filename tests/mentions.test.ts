import { describe, expect, it } from "vitest";
import { HELP_TEXT, attachMentions, findMentions, matchCommands, matchNotes, parseSlash } from "../src/mentions";
import { FakeVault } from "./fakes";

function vault() {
	return new FakeVault({
		"Projects/Chess Robot.md": "# Chess Robot\n\nThe gantry moves pieces.",
		"Ideas/Sensors.md": "Hall sensors are cheap.",
		"Daily/2026-11-05.md": "today",
	});
}

describe("mentions", () => {
	it("finds resolvable wikilinks once each and attaches their contents", async () => {
		const v = vault();
		expect(findMentions("See [[Chess Robot]] and [[Chess Robot#Status|x]] and [[Nope]]", v).map((m) => m.path)).toEqual(["Projects/Chess Robot.md"]);
		const { message, attached } = await attachMentions("Compare [[Chess Robot]] with [[Ideas/Sensors]].", v, 10_000);
		expect(attached).toEqual(["Projects/Chess Robot.md", "Ideas/Sensors.md"]);
		expect(message).toContain("--- Attached note: Projects/Chess Robot.md ---\n# Chess Robot");
		expect(message).toContain("--- Attached note: Ideas/Sensors.md ---\nHall sensors are cheap.");
		expect(message).toMatch(/do not read them again/);
	});
	it("leaves plain messages alone and respects the budget", async () => {
		const v = vault();
		expect((await attachMentions("hello", v, 100)).message).toBe("hello");
		v.seed("Big.md", "x".repeat(5000));
		const { message, attached } = await attachMentions("[[Big]] and [[Ideas/Sensors]]", v, 1000);
		expect(attached).toEqual(["Big.md"]);
		expect(message).toContain("[… truncated");
	});
});

describe("note and command matching", () => {
	it("ranks name prefixes above substrings and paths", () => {
		const notes = vault().listNotes();
		expect(matchNotes("chess", notes).map((n) => n.basename)).toEqual(["Chess Robot"]);
		expect(matchNotes("rob", notes).map((n) => n.basename)).toEqual(["Chess Robot"]);
		expect(matchNotes("ideas", notes).map((n) => n.path)).toEqual(["Ideas/Sensors.md"]);
		expect(matchNotes("", notes)).toHaveLength(3);
		expect(matchNotes("zzz", notes)).toHaveLength(0);
	});
	it("matches and parses slash commands", () => {
		expect(matchCommands("un").map((c) => c.id)).toEqual(["undo", "undo-all"]);
		expect(matchCommands("/").length).toBeGreaterThan(5);
		expect(parseSlash("/undo")?.id).toBe("undo");
		expect(parseSlash("/reformat please")?.id).toBe("reformat");
		expect(parseSlash("/nope")).toBeNull();
		expect(parseSlash("what is /undo")).toBeNull();
		expect(HELP_TEXT).toContain("`/undo`");
	});
});
