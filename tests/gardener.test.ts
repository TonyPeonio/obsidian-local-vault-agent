import { describe, expect, it } from "vitest";
import {
	CHAT_CAP,
	LEGACY_SUGGESTIONS_NOTE,
	countWordOccurrences,
	gardenFixes,
	gardenVault,
	maskProse,
	mentionName,
	planCopyRemoval,
	planGardenAction,
	planLinkRepairs,
	planMentionLinks,
	renderGardenChat,
	renderPlanResult,
	type GardenReport,
} from "../src/gardener";
import { FakeVault } from "./fakes";

function vaultWithProblems(): FakeVault {
	const v = new FakeVault({
		"Projects/Chess Robot.md": "# Chess Robot\n\nThe gantry moves pieces. See [[Ideas/Sensors]] and [[Ideas/Nope]].\n\nMarcus Vale built the frame; the chess robot drags pieces. " + "More text. ".repeat(20),
		"Ideas/Sensors.md": "# Sensors\n\nHall sensors are cheap. The Chess Robot uses them, and the chess robot likes them.\n" + "Detail. ".repeat(30),
		"People/Marcus Vale.md": "# Marcus Vale\n\nFriend from the makerspace.",
		"Ideas/Lonely.md": "# Lonely\n\nNobody links here and I link nowhere, but I have enough words to not be a stub at all, really quite a few of them.",
		"Ideas/Stub.md": "# Stub\n\ntodo",
		"Daily/2026-10-01.md": "# 2026-10-01\n\n## Done\n\n- x\n\n## Capture\n\n- a\n- b\n- c\n- d\n\n## Tomorrow\n",
		"Daily/2026-10-02.md": "# 2026-10-02\n\n## Done\n\n- y\n\n## Capture\n\n- one liner\n",
		"Templates/Daily.md": "# {{date}}",
		[LEGACY_SUGGESTIONS_NOTE]: "# Vault Suggestions\n\n- [ ] [[Ideas/Gone]] old finding",
	});
	return v;
}

const OPTS = { dailyFolder: "Daily", inboxHeading: "Capture", exclude: (p: string) => p.startsWith("Templates/") };

describe("gardenVault", () => {
	it("finds broken links, orphans, unlinked mentions, stubs and full inboxes", async () => {
		const vault = vaultWithProblems();
		const r = await gardenVault(vault, { ...OPTS, now: new Date("2026-11-07T12:00:00Z") });
		expect(r.generated).toBe("2026-11-07");
		expect(r.notes).toBe(7);
		expect(r.broken).toEqual([{ path: "Projects/Chess Robot.md", target: "Ideas/Nope" }]);
		// Marcus Vale is only ever mentioned in prose, never linked, so it is an orphan too.
		expect(r.orphans).toEqual(["Ideas/Lonely.md", "Ideas/Stub.md", "People/Marcus Vale.md"]);
		// "Chess Robot" appears once in Sensors as a name (the lower-case "chess robot" is not counted,
		// nor would a wikilink be) and Marcus Vale once in Chess Robot; a note never mentions itself.
		expect(r.mentions).toEqual([
			{ path: "Ideas/Sensors.md", target: "Projects/Chess Robot.md", count: 1 },
			{ path: "Projects/Chess Robot.md", target: "People/Marcus Vale.md", count: 1 },
		]);
		expect(r.stubs).toEqual([
			{ path: "Ideas/Stub.md", chars: 4 },
			{ path: "People/Marcus Vale.md", chars: 27 },
		]);
		expect(r.inboxes).toEqual([{ path: "Daily/2026-10-01.md", lines: 4 }]);
		expect(r.duplicates).toEqual([]);
	});

	it("recognises daily notes by name when no folder is configured", async () => {
		const vault = new FakeVault({ "2026-01-01.md": "# d\n\n## Capture\n\n- a\n- b\n- c\n", "Note With Name.md": "# n\n\nx" });
		const r = await gardenVault(vault, {});
		expect(r.inboxes).toEqual([{ path: "2026-01-01.md", lines: 3 }]);
		expect(r.orphans).toEqual(["Note With Name.md"]);
		expect(r.stubs.map((s) => s.path)).toEqual(["Note With Name.md"]);
	});

	it("ignores the checklist note older versions wrote", async () => {
		const r = await gardenVault(vaultWithProblems(), OPTS);
		expect(r.broken.map((b) => b.target)).not.toContain("Ideas/Gone");
	});

	it("does not call a note that is one query block a stub", async () => {
		const vault = new FakeVault({ "Master Task List.md": "```tasks\nnot done\nsort by due\ngroup by filename\nhide backlink\n```\n", "Hub.md": "See [[Master Task List]] for everything open. " + "x ".repeat(40) });
		expect((await gardenVault(vault, {})).stubs).toEqual([]);
	});
});

describe("broken links", () => {
	it("tells a link whose target moved from one whose target is gone", async () => {
		const vault = new FakeVault({
			"Hub.md": "Tools: [[Old/GenKIC]], [[Old/GenKIC|the mover]] and ![[Old/Vanished]]. Audio: [[Recording 1.m4a]] and [[Lost.m4a]]. " + "x ".repeat(40),
			"New/GenKIC.md": "Generalized kinematic closure. " + "y ".repeat(60),
		});
		vault.seedFile("School/attachments/Recording 1.m4a");
		const r = await gardenVault(vault, {});
		// A bare attachment name resolves wherever the file is, as in Obsidian; [[Old/GenKIC]] does not
		// resolve to New/GenKIC, but that is the one note of that name, so it is what the link meant.
		expect(r.broken).toEqual([
			{ path: "Hub.md", target: "Old/GenKIC", suggestion: "New/GenKIC.md" },
			{ path: "Hub.md", target: "Old/Vanished" },
			{ path: "Hub.md", target: "Lost.m4a" },
		]);
		const md = renderGardenChat(r);
		expect(md).toContain("- [[Hub]] links to `[[Old/GenKIC]]` — it is now [[New/GenKIC]]");
		expect(gardenFixes(r).find((f) => f.action === "repair-links")).toEqual({ action: "repair-links", label: "Repoint 1 moved link" });
	});

	it("does not guess when two notes have the name", async () => {
		const vault = new FakeVault({ "Hub.md": "[[Old/Notes]] " + "x ".repeat(40), "A/Notes.md": "a ".repeat(60), "B/Notes.md": "b ".repeat(60) });
		expect((await gardenVault(vault, {})).broken).toEqual([{ path: "Hub.md", target: "Old/Notes" }]);
	});

	it("repoints every form of the link in one edit per note, keeping aliases and headings", async () => {
		const vault = new FakeVault({
			"Hub.md": "Tools: [[Old/GenKIC]], [[Old/GenKIC|the mover]], [[Old/GenKIC#Tutorial]] and ![[Old/GenKIC]]. Not [[Old/GenKIC2]].",
			"New/GenKIC.md": "x",
		});
		const plan = await planLinkRepairs(vault, [{ path: "Hub.md", target: "Old/GenKIC", suggestion: "New/GenKIC.md" }]);
		expect(plan.skipped).toEqual([]);
		expect(plan.changes).toHaveLength(1);
		expect(plan.changes[0]).toMatchObject({ tool: "edit_note", path: "Hub.md", summary: "Hub.md: [[Old/GenKIC]] → [[New/GenKIC]]" });
		expect(plan.changes[0].after).toBe("Tools: [[New/GenKIC]], [[New/GenKIC|the mover]], [[New/GenKIC#Tutorial]] and ![[New/GenKIC]]. Not [[Old/GenKIC2]].");
	});

	it("skips a repair whose link or target has gone since the report", async () => {
		const vault = new FakeVault({ "Hub.md": "nothing to see", "New/GenKIC.md": "x" });
		const plan = await planLinkRepairs(vault, [
			{ path: "Hub.md", target: "Old/GenKIC", suggestion: "New/GenKIC.md" },
			{ path: "Hub.md", target: "Old/Other", suggestion: "New/Other.md" },
			{ path: "Hub.md", target: "Old/NoIdea" },
		]);
		expect(plan.changes).toEqual([]);
		expect(plan.skipped).toHaveLength(2);
	});
});

describe("unlinked mentions", () => {
	it("looks only for names that are distinctive", () => {
		// A name with a capital is looked for as written; a lower-case one in any case.
		expect(mentionName("Chess Robot")).toEqual({ name: "Chess Robot", exact: true });
		expect(mentionName("meeting notes")).toEqual({ name: "meeting notes", exact: false });
		expect(mentionName("GenKIC")).toEqual({ name: "GenKIC", exact: true });
		expect(mentionName("HighFold2")).toEqual({ name: "HighFold2", exact: true });
		// Ordinary single words, whatever their case, and dates.
		for (const n of ["Classes", "Bioinformatics", "PROPERTIES", "README", "2026-10-01", "2026-10-01 Standup", "Notes"]) expect(mentionName(n)).toBeNull();
	});

	it("leaves out the folder's own note, notes already linked, shared names and ordinary words", async () => {
		const vault = new FakeVault({
			"School/Machine Learning.md": "# Machine Learning\n\nThe course note. " + "x ".repeat(50),
			"School/Machine Learning/2026-09-10.md": "Today in machine learning: supervised machine learning. " + "y ".repeat(50),
			"School/Classes.md": "List of classes this term. " + "z ".repeat(50),
			"School/Bioinformatics/2026-09-11.md": "Two classes of alignment; machine learning comes later (see Machine Learning), and GenKIC is unrelated. genkic in lower case is not the note. " + "w ".repeat(40),
			"Work/GenKIC.md": "Generalized kinematic closure. " + "k ".repeat(60),
			"Work/Chess Robot.md": "The robot. See [[Work/GenKIC]]: GenKIC closes loops. " + "c ".repeat(50),
			"A/Shared Name.md": "a ".repeat(60),
			"B/Shared Name.md": "b ".repeat(60),
			"Log.md": "The shared name appears here. " + "l ".repeat(50),
		});
		const r = await gardenVault(vault, {});
		expect(r.mentions).toEqual([
			{ path: "School/Bioinformatics/2026-09-11.md", target: "School/Machine Learning.md", count: 1 },
			{ path: "School/Bioinformatics/2026-09-11.md", target: "Work/GenKIC.md", count: 1 },
		]);
	});

	it("masks everything that is not prose without moving anything", () => {
		const note = "---\ntitle: Chess Robot\n---\n# Chess Robot\n\n`Chess Robot` and [[Chess Robot]] and [Chess Robot](https://x.y/Chess Robot)\n| Chess Robot | table |\n```\nChess Robot\n```\nReal Chess Robot here.";
		const masked = maskProse(note);
		expect(masked.length).toBe(note.length);
		expect(countWordOccurrences(masked, "Chess Robot")).toBe(1);
		expect(masked.indexOf("Chess Robot")).toBe(note.lastIndexOf("Chess Robot"));
	});

	it("links the first mention as written, one edit per note", async () => {
		const vault = new FakeVault({
			"Ideas/Sensors.md": "# Sensors and the Chess Robot\n\nHall sensors are cheap. The chess robot uses them, and the Chess Robot likes them. GenKIC too. Our meeting Notes say so.",
			"Projects/Chess Robot.md": "x",
			"Work/GenKIC.md": "y",
			"Log/meeting notes.md": "z",
		});
		const plan = await planMentionLinks(vault, [
			{ path: "Ideas/Sensors.md", target: "Projects/Chess Robot.md" },
			{ path: "Ideas/Sensors.md", target: "Work/GenKIC.md" },
			{ path: "Ideas/Sensors.md", target: "Log/meeting notes.md" },
			{ path: "Ideas/Sensors.md", target: "Work/Gone Away.md" },
		]);
		expect(plan.changes).toHaveLength(1);
		// The heading is left alone, and so is the lower-case "chess robot"; a lower-case name is
		// matched in any case, and the words keep theirs as the alias.
		expect(plan.changes[0].after).toBe(
			"# Sensors and the Chess Robot\n\nHall sensors are cheap. The chess robot uses them, and the [[Projects/Chess Robot|Chess Robot]] likes them. [[Work/GenKIC|GenKIC]] too. Our [[Log/meeting notes|meeting Notes]] say so.",
		);
		expect(plan.changes[0].summary).toBe('Ideas/Sensors.md: linked "Chess Robot" to [[Projects/Chess Robot]]; linked "GenKIC" to [[Work/GenKIC]]; linked "meeting Notes" to [[Log/meeting notes]]');
		expect(plan.skipped).toEqual(["[[Ideas/Sensors]]: no plain mention of [[Work/Gone Away]] left"]);
		// Applied, nothing is left to link.
		await vault.modify("Ideas/Sensors.md", plan.changes[0].after);
		expect((await planMentionLinks(vault, [{ path: "Ideas/Sensors.md", target: "Work/GenKIC.md" }])).changes).toEqual([]);
	});
});

describe("countWordOccurrences", () => {
	it("matches whole words only", () => {
		expect(countWordOccurrences("the chess robot and chess robots", "chess robot")).toBe(1);
		expect(countWordOccurrences("sensors, sensors.", "sensors")).toBe(2);
		expect(countWordOccurrences("supersensors", "sensors")).toBe(0);
	});
});

const BODY = (name: string) => `\`${name}\` is useful for the following scenarios:\n\n- Given a structure, one wants to covalently connect new residues.\n- Given a structure, one wants to insert new residues after an anchor.\n- One wants to generate a peptide of known length from scratch.\n`;

function vaultWithCopies(): FakeVault {
	return new FakeVault({
		// A folder that was copied: the same notes twice, each copy linking within its own folder.
		"Work/Tools/PeptideStubMover.md": BODY("PeptideStubMover"),
		"Work/Rosetta Tools/PeptideStubMover.md": BODY("PeptideStubMover"),
		"Work/Tools/GenKIC.md": "Closure. Uses [[Work/Tools/PeptideStubMover]] to add loop residues to a pose that lacks a loop, then closes it.\n" + BODY("GenKIC"),
		"Work/Rosetta Tools/GenKIC.md": "---\ntags: [rosetta]\n---\nClosure. Uses [[Work/Rosetta Tools/PeptideStubMover]] to add loop residues to a pose that lacks a loop, then closes it.\n\n" + BODY("GenKIC"),
		"Work/Rosetta Tools/Code Snippets.md": "Snippets for [[Work/Rosetta Tools/GenKIC]] and [[Work/Rosetta Tools/PeptideStubMover]]. " + "s ".repeat(50),
		"Work/Project.md": "Old links: [[Work/Tools/GenKIC]] and [[Work/Tools/PeptideStubMover|the stub mover]]. " + "p ".repeat(50),
	});
}

describe("duplicates", () => {
	it("finds identical copies without an index and keeps the one the vault points at", async () => {
		const r = await gardenVault(vaultWithCopies(), {});
		// Frontmatter, blank lines and the folder inside a wikilink do not make two notes different.
		expect(r.duplicates).toEqual([
			{ a: "Work/Rosetta Tools/PeptideStubMover.md", b: "Work/Tools/PeptideStubMover.md", score: 1, identical: true },
			{ a: "Work/Rosetta Tools/GenKIC.md", b: "Work/Tools/GenKIC.md", score: 1, identical: true },
		]);
		const md = renderGardenChat(r, { hasIndex: false });
		expect(md).toContain("- [[Work/Tools/GenKIC]] is a copy of [[Work/Rosetta Tools/GenKIC]] (identical text)");
		expect(md).toContain("Only exact copies are detected without semantic search");
		expect(gardenFixes(r).map((f) => f.label)).toContain("Remove 2 identical copies");
	});

	it("does not report notes the index calls similar unless they share their lines", async () => {
		const slides = "> [!note]- Slide text\n> Machine learning is a field of inquiry devoted to understanding methods that learn.\n> Programs learn patterns from data, not hard-coded rules.\n";
		const lecture = (date: string, body: string) => `---\ncourse: Machine Learning\ndate: ${date}\n---\n\n## Slides\n\n${slides}\n## Summary\n\n${body}\n`;
		const vault = new FakeVault({
			"School/ML/2026-09-10.md": lecture("2026-09-10", "- Linear regression fits a line by least squares to the training data.\n- The bias term shifts the line away from the origin.\n- Gradient descent follows the slope of the loss downhill."),
			"School/ML/2026-09-17.md": lecture("2026-09-17", "- Logistic regression squashes a linear score through the sigmoid.\n- Cross-entropy is the loss that goes with the sigmoid output.\n- A decision boundary is where the score crosses zero."),
			"Notes/Regression.md": "# Regression\n\n- Linear regression fits a line by least squares to the training data.\n- The bias term shifts the line away from the origin.\n- Gradient descent follows the slope of the loss downhill.\n- Regularisation keeps the weights small.\n",
		});
		const same = new Float32Array([1, 0]);
		const vectors = new Map([...vault.listNotes().map((n) => [n.path, same] as const)]);
		// No daily folder is set, so dated names would be skipped as daily notes; name one.
		const r = await gardenVault(vault, { dailyFolder: "Daily", noteVectors: vectors });
		// The two lectures share a template and a slide deck, not their content. The regression note
		// repeats one lecture's three points.
		expect(r.duplicates).toEqual([{ a: "Notes/Regression.md", b: "School/ML/2026-09-10.md", score: 1, identical: false }]);
		expect(renderGardenChat(r)).toContain("- [[School/ML/2026-09-10]] shares 100% of its lines with [[Notes/Regression]]");
		const review = gardenFixes(r).find((f) => f.action === "review-similar")!;
		expect(review.prompt).toContain("[[School/ML/2026-09-10]] shares 100% of its lines with [[Notes/Regression]]");
		expect(review.prompt).toContain("Change nothing yet");
	});

	it("repoints links to the copy, then moves it to the trash", async () => {
		const vault = vaultWithCopies();
		const r = await gardenVault(vault, {});
		const plan = (await planGardenAction(vault, "remove-copies", r))!;
		expect(plan.skipped).toEqual([]);
		expect(plan.changes.map((c) => `${c.tool} ${c.path}`)).toEqual(["edit_note Work/Project.md", "delete_file Work/Tools/PeptideStubMover.md", "delete_file Work/Tools/GenKIC.md"]);
		// The copy that is itself going is not edited first; the note that stays is untouched.
		expect(plan.changes[0].after).toContain("Old links: [[Work/Rosetta Tools/GenKIC]] and [[Work/Rosetta Tools/PeptideStubMover|the stub mover]].");
		expect(plan.changes[1]).toMatchObject({ after: "", summary: "Delete Work/Tools/PeptideStubMover.md (identical to Work/Rosetta Tools/PeptideStubMover.md; moved to the trash)" });
	});

	it("skips a pair that is no longer identical or no longer there", async () => {
		const vault = vaultWithCopies();
		const r = await gardenVault(vault, {});
		await vault.modify("Work/Tools/GenKIC.md", (await vault.read("Work/Tools/GenKIC.md")) + "\nA line only this copy has.\n");
		await vault.trash("Work/Tools/PeptideStubMover.md");
		const plan = await planCopyRemoval(vault, r.duplicates);
		expect(plan.changes).toEqual([]);
		expect(plan.skipped).toEqual(["[[Work/Tools/PeptideStubMover]]: one of the two notes is already gone", "[[Work/Tools/GenKIC]]: no longer identical to [[Work/Rosetta Tools/GenKIC]]"]);
	});
});

const EMPTY: GardenReport = { generated: "2026-11-07", notes: 3, broken: [], orphans: [], mentions: [], stubs: [], inboxes: [], duplicates: [] };

describe("renderGardenChat", () => {
	it("lists each section as plain bullets, never as tasks", async () => {
		const r = await gardenVault(vaultWithProblems(), { ...OPTS, now: new Date("2026-11-07") });
		const md = renderGardenChat(r, { hasIndex: false });
		expect(md).toMatch(/^\*\*Vault suggestions\*\* — checked 7 notes\. Nothing has been changed or written\./);
		expect(md).toContain("**Broken links (1)**");
		expect(md).toContain("- [[Projects/Chess Robot]] links to `[[Ideas/Nope]]`");
		expect(md).toContain("**Daily inboxes with content (1)**");
		expect(md).toContain("- [[Daily/2026-10-01]] — 4 lines");
		expect(md).toContain("- [[Ideas/Sensors]] mentions [[Projects/Chess Robot]] once without linking");
		expect(md).toContain("**Orphans (3)**");
		expect(md).toContain("- [[Ideas/Stub]] — 4 characters");
		// A checkbox anywhere would land in every task query over the vault if the text were pasted into a note.
		expect(md).not.toMatch(/\[ \]|\[x\]/i);
		expect(md).not.toMatch(/^#/m);
	});

	it("caps a long section and says how many are left", () => {
		const orphans = Array.from({ length: CHAT_CAP + 5 }, (_, i) => `Ideas/N${String(i).padStart(2, "0")}.md`);
		const md = renderGardenChat({ ...EMPTY, orphans });
		expect(md).toContain(`**Orphans (${CHAT_CAP + 5})**`);
		expect(md.split("\n").filter((l) => l.startsWith("- [[Ideas/N")).length).toBe(CHAT_CAP);
		expect(md).toContain("- …and 5 more");
	});

	it("says so when there is nothing to suggest", () => {
		expect(renderGardenChat(EMPTY)).toContain("found nothing to suggest");
	});
});

describe("gardenFixes", () => {
	it("needs the model only where judgment is needed", async () => {
		const r = await gardenVault(vaultWithProblems(), OPTS);
		const fixes = gardenFixes(r);
		// The broken link has no note to point at and stubs get no action.
		expect(fixes.map((f) => f.action)).toEqual(["inboxes", "link-mentions", "orphans"]);
		expect(fixes.filter((f) => f.prompt).map((f) => f.action)).toEqual(["orphans"]);
		expect(fixes.find((f) => f.action === "link-mentions")!.label).toBe("Link 2 mentions");
	});

	it("never asks for tasks, and only asks for a proposal", () => {
		const fixes = gardenFixes({ ...EMPTY, orphans: ["D.md"], duplicates: [{ a: "A.md", b: "C.md", score: 0.8, identical: false }] });
		expect(fixes.map((f) => f.action)).toEqual(["review-similar", "orphans"]);
		for (const f of fixes) {
			expect(f.prompt).toContain("Never add checkboxes, tasks or TODO items");
			expect(f.prompt).toContain("Change nothing yet");
			expect(f.prompt).not.toMatch(/\[ \]/);
		}
	});

	it("acts on the findings that are listed, no more", async () => {
		const mentions = Array.from({ length: CHAT_CAP + 10 }, (_, i) => ({ path: `N${i}.md`, target: "Projects/Chess Robot.md", count: 1 }));
		const r = { ...EMPTY, mentions };
		expect(gardenFixes(r)[0].label).toBe(`Link ${CHAT_CAP} mentions`);
		const vault = new FakeVault({ "Projects/Chess Robot.md": "x", ...Object.fromEntries(mentions.map((m) => [m.path, "The Chess Robot again."])) });
		expect((await planGardenAction(vault, "link-mentions", r))!.changes).toHaveLength(CHAT_CAP);
		expect(await planGardenAction(vault, "orphans", r)).toBeNull();
	});

	it("offers nothing when there is nothing to fix", () => {
		expect(gardenFixes(EMPTY)).toEqual([]);
		expect(gardenFixes({ ...EMPTY, stubs: [{ path: "S.md", chars: 3 }], broken: [{ path: "A.md", target: "Gone" }] })).toEqual([]);
	});
});

describe("renderPlanResult", () => {
	it("reports what was done, what was skipped and where it stopped", async () => {
		const vault = vaultWithCopies();
		const plan = (await planGardenAction(vault, "remove-copies", await gardenVault(vault, {})))!;
		const all = renderPlanResult(plan.changes, plan, false);
		expect(all).toMatch(/^Done, without the model: 3 notes changed\. `\/undo-all` takes all of it back\./);
		expect(all).toContain("- [[Work/Project]] — [[Work/Tools/PeptideStubMover]] → [[Work/Rosetta Tools/PeptideStubMover]]; [[Work/Tools/GenKIC]] → [[Work/Rosetta Tools/GenKIC]]");
		expect(all).toContain("- [[Work/Tools/GenKIC]] moved to the trash");
		expect(renderPlanResult(plan.changes.slice(0, 1), plan, true)).toContain("Stopped at the change you rejected; 2 planned changes not applied.");
		expect(renderPlanResult([], plan, true)).toBe("Nothing was changed: you rejected the first change.");
		expect(renderPlanResult([], { changes: [], skipped: ["[[A]]: gone"] }, false)).toBe("Nothing to change: none of the listed findings still applies.\n\nSkipped:\n- [[A]]: gone");
		expect(all).not.toMatch(/\[ \]/);
	});
});
