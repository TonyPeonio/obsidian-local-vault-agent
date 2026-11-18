import { describe, expect, it } from "vitest";
import { HELP_TEXT, attachMentions, findMentions, linkedPassages, matchCommands, matchNotes, parseSlash } from "../src/mentions";
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

describe("what an attached note links to", () => {
	const engine = () => {
		const v = new FakeVault({
			"Projects/Kirin Engine.md": "# Kirin Engine\n\nC++ chess engine.\n\n## Evaluation\n\n- NNUE net `kirin-2026-10.knnue`, trained on 40M positions ([[NNUE Training]]).\n\nSee also [[Projects/Chess Robot]].",
			"Projects/NNUE Training.md": "# NNUE Training\n\n## Runs\n\n- 2026-10-20: 40M positions, 15 epochs, validation loss 0.071 (best so far).\n\n## Hardware\n\nOne RTX 5070, about nine hours a run.",
			"Projects/Chess Robot.md": "# Chess Robot\n\nA gantry under the board moves pieces.",
			"Unlinked/Losses.md": "validation loss 0.5 in an unrelated experiment",
		});
		return v;
	};

	it("brings along the passage that has the words the attached note lacks", async () => {
		const { message, attached } = await attachMentions("[[Projects/Kirin Engine]] What NNUE net is in use and what was its validation loss?", engine(), 24_000);
		expect(attached).toEqual(["Projects/Kirin Engine.md"]);
		expect(message).toContain("--- From Projects/NNUE Training.md › Runs, which the attached note links to ---\n- 2026-10-20: 40M positions, 15 epochs, validation loss 0.071 (best so far).");
		// Only what has the missing words: not the rest of that note, not other linked notes, not notes that are not linked.
		expect(message).not.toContain("about nine hours a run");
		expect(message).not.toContain("gantry under the board");
		expect(message).not.toContain("unrelated experiment");
	});

	it("brings nothing when the attached note already has every word of the question, or when asked to rework the note itself", async () => {
		const v = engine();
		for (const q of ["[[Projects/Kirin Engine]] What net is the engine trained on?", "Summarise [[Projects/Kirin Engine]]", "Reformat [[Projects/Kirin Engine]] as a table"]) {
			expect((await attachMentions(q, v, 24_000)).message, q).not.toContain("which the attached note links to");
		}
		expect(await linkedPassages("validation loss", [], v, 2000)).toEqual([]);
	});

	it("stays within its budget and survives a linked note that cannot be read", async () => {
		const v = engine();
		v.seed("Projects/NNUE Training.md", "# NNUE Training\n\n" + "validation loss was high. ".repeat(200));
		const got = await linkedPassages("what was the validation loss", ["Projects/Kirin Engine.md"], v, 2400);
		// A long section is several passages; each is cut, and together they stay within the budget.
		expect(got.length).toBeGreaterThanOrEqual(1);
		expect(got.every((p) => p.text.length <= 830)).toBe(true);
		expect(got.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(2400);
		expect(await linkedPassages("what was the validation loss", ["Projects/Kirin Engine.md"], v, 200)).toEqual([]);
		const broken = Object.assign(Object.create(Object.getPrototypeOf(v)) as FakeVault, v, {
			read: async (p: string) => {
				if (p.includes("NNUE")) throw new Error("excluded");
				return FakeVault.prototype.read.call(v, p);
			},
		});
		expect(await linkedPassages("what was the validation loss", ["Projects/Kirin Engine.md"], broken, 2400)).toEqual([]);
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
