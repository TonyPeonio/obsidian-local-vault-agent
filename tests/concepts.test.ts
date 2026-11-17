import { describe, expect, it } from "vitest";
import { addRelatedSection, applyConceptLinks, conceptNames, isConceptNote, setLinkProperty, suggestConcepts } from "../src/concepts";
import type { NoteInfo } from "../src/types";

const note = (path: string): NoteInfo => ({ path, basename: path.split("/").pop()!.replace(/\.md$/, ""), folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", mtime: 0, ctime: 0, size: 1 });

describe("concept notes", () => {
	it("are in a concept folder, tagged, or typed", () => {
		expect(isConceptNote(note("Concepts/Entropy.md"), ["Concepts"])).toBe(true);
		expect(isConceptNote(note("School/Concepts/Entropy.md"), ["Concepts"])).toBe(true);
		expect(isConceptNote(note("Ideas/Entropy.md"), ["Concepts"])).toBe(false);
		expect(isConceptNote(note("Ideas/Entropy.md"), [], { tags: ["#concept"] })).toBe(true);
		expect(isConceptNote(note("Ideas/Entropy.md"), [], { frontmatter: { type: "Topic" } })).toBe(true);
	});

	it("go by their name and aliases", () => {
		expect(conceptNames(note("Concepts/Gradient Descent.md"), ["GD", "steepest descent"])).toEqual(["Gradient Descent", "steepest descent"]);
		expect(conceptNames(note("Concepts/Entropy.md"), "disorder, S")).toEqual(["Entropy", "disorder"]);
	});
});

const LECTURE = [
	"---",
	"course: PHYS 201",
	"---",
	"# 2026-11-02",
	"",
	"We derived entropy from counting microstates, then used gradient descent to fit the curve.",
	"Entropy again here. Already linked: [[Concepts/Heat Engines]].",
	"`entropy` in code is not a mention.",
].join("\n");

const CONCEPTS = ["Concepts/Entropy.md", "Concepts/Gradient Descent.md", "Concepts/Descent.md", "Concepts/Heat Engines.md", "Concepts/Carnot Cycle.md", "Concepts/Unrelated.md"].map((p) => ({ note: note(p), names: conceptNames(note(p), undefined) }));

describe("suggestConcepts", () => {
	it("finds first plain mentions, longest names first, skipping linked ones; then related ones by meaning", () => {
		const s = suggestConcepts({ path: "Courses/PHYS 201/2026-11-02.md", content: LECTURE }, CONCEPTS, [
			{ path: "Concepts/Carnot Cycle.md", score: 0.8 },
			{ path: "Concepts/Heat Engines.md", score: 0.9 },
			{ path: "Ideas/Not a concept.md", score: 0.99 },
		]);
		expect(s.map((x) => [x.path, x.kind])).toEqual([
			["Concepts/Gradient Descent.md", "mentioned"],
			["Concepts/Entropy.md", "mentioned"],
			["Concepts/Carnot Cycle.md", "related"],
		]);
		expect(s[1].mention).toEqual({ at: LECTURE.indexOf("entropy from"), text: "entropy" });
	});
});

describe("frontmatter and sections", () => {
	it("sets a link property, merging what is there", () => {
		expect(setLinkProperty("# Note\n", "parent", ["[[A]]"])).toBe('---\nparent:\n  - "[[A]]"\n---\n# Note\n');
		const fm = '---\ncourse: X\nparent: "[[A]]"\ntags: [a]\n---\nbody';
		expect(setLinkProperty(fm, "parent", ["[[A]]", "[[B]]"])).toBe('---\ncourse: X\nparent:\n  - "[[A]]"\n  - "[[B]]"\ntags: [a]\n---\nbody');
		const list = '---\nchild:\n  - "[[A|a]]"\n  - "[[C]]"\n---\nbody';
		expect(setLinkProperty(list, "child", ["[[a]]", "[[D]]"])).toBe('---\nchild:\n  - "[[A|a]]"\n  - "[[C]]"\n  - "[[D]]"\n---\nbody');
		expect(setLinkProperty("---\r\nx: 1\r\n---\r\nb", "parent", ["[[A]]"])).toBe('---\r\nx: 1\r\nparent:\r\n  - "[[A]]"\r\n---\r\nb');
	});

	it("adds related links under their heading once", () => {
		expect(addRelatedSection("text\n", ["Concepts/A.md"])).toBe("text\n\n## Related concepts\n\n- [[Concepts/A]]\n");
		const has = "text\n\n## Related concepts\n\n- [[Concepts/A]]\n\n## Next\nmore";
		expect(addRelatedSection(has, ["Concepts/A.md", "Concepts/B.md"])).toBe("text\n\n## Related concepts\n\n- [[Concepts/A]]\n- [[Concepts/B]]\n\n## Next\nmore");
	});

	it("applies the chosen links, related section and property in one change", () => {
		const s = suggestConcepts({ path: "L.md", content: LECTURE }, CONCEPTS, [{ path: "Concepts/Carnot Cycle.md", score: 0.7 }]);
		const out = applyConceptLinks(LECTURE, s, "parent");
		expect(out).toContain("We derived [[Concepts/Entropy|entropy]] from counting microstates, then used [[Concepts/Gradient Descent|gradient descent]] to fit");
		expect(out).toContain("Entropy again here.");
		expect(out).toContain("## Related concepts\n\n- [[Concepts/Carnot Cycle]]");
		expect(out).toMatch(/^---\ncourse: PHYS 201\nparent:\n {2}- "\[\[Concepts\/Gradient Descent\]\]"\n {2}- "\[\[Concepts\/Entropy\]\]"\n {2}- "\[\[Concepts\/Carnot Cycle\]\]"\n---/);
		expect(applyConceptLinks(LECTURE, [], "parent")).toBe(LECTURE);
	});
});
