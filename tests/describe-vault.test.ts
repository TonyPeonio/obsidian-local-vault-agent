import { describe, expect, it } from "vitest";
import { DESCRIPTION_END, DESCRIPTION_START, describeVault, refreshDescription } from "../src/describe-vault";
import { FakeVault } from "./fakes";

function vault(): FakeVault {
	const v = new FakeVault({});
	for (let d = 1; d <= 20; d++) v.seed(`Daily/2026-09-${String(d).padStart(2, "0")}.md`, `# Day\n\n## Done\n\n- x\n\n## Capture\n\n## Tomorrow\n\n- [ ] y\n`);
	for (const course of ["CSCI 406", "CSCI 470", "MATH 332"]) {
		v.seed(`School/${course}/Lectures - ${course}.md`, `# Lectures\n\n## 2026-09-03\n\ntext\n\n### Summary\n\n- s\n\n## 2026-09-10\n\ntext\n\n### Summary\n\n- s\n`);
		v.seed(`School/${course}/HW1 - ${course}.md`, `# HW1\n\n## Problems\n\n1. a\n\n## Notes\n\n- b\n`);
	}
	for (let i = 1; i <= 6; i++) v.seed(`Meetings/2026-10-${String(i).padStart(2, "0")} Ana - sync.md`, `---\ntags: [meeting]\nstatus: ${i % 2 ? "done" : "open"}\n---\n# Sync\n\n## Agenda\n\n- a\n\n## Actions\n\n- [ ] b\n`);
	for (let i = 1; i <= 4; i++) v.seed(`Templates/T${i}.md`, "## Done\n\ntemplate");
	v.seed("Projects/Robot.md", "# Robot\n\nfree text");
	v.seed("AGENT.md", "old");
	return v;
}

describe("describeVault", () => {
	it("writes down what most notes of a folder agree on, and nothing it would have to guess", () => {
		const out = describeVault(vault(), { excluded: ["Templates"], today: "2026-11-17", conventionsPath: "AGENT.md" });
		expect(out).toContain("- `Daily/` — 20 notes, named `YYYY-MM-DD`; sections `## Done`, `## Capture`, `## Tomorrow`.");
		expect(out).toContain("- `Meetings/` — 6 notes, named `YYYY-MM-DD <title>`; sections `## Agenda`, `## Actions`.");
		// One folder per course: what each of them has, with the dated sections of the lecture notes.
		expect(out).toMatch(/- `School\/<name>\/` — 3 folders, 6 notes; each has .*`Lectures - <name>\.md` \(one `## YYYY-MM-DD` section per entry, with `### Summary` under it where present\)/);
		expect(out).toContain("`HW<n> - <name>.md` (sections `## Problems`, `## Notes`)");
		// A folder with nothing in common gets its count and no invented structure.
		expect(out).toContain("- `Projects/` — 1 note.");
		expect(out).toContain("- `Templates/` — excluded in the plugin's settings: never read, search or edit.");
		expect(out).not.toContain("T1");
		expect(out).not.toContain("AGENT");
		// A property with a small vocabulary shows it.
		expect(out).toMatch(/Properties in use: .*`status` \((done, open|open, done)\)/);
		expect(out).toContain("#meeting (6)");
		expect(out).toContain("Most notes have no properties block: never add YAML frontmatter to a note that has none.");
		expect(out).toContain("was drafted from this vault on 2026-11-17");
	});

	it("stays short enough to send with every message, dropping the smallest folders first", () => {
		const v = new FakeVault({});
		for (let f = 0; f < 40; f++) for (let i = 0; i <= f; i++) v.seed(`Folder number ${String(f).padStart(2, "0")} with a long name/Note ${i}.md`, "## A\n\nx");
		const out = describeVault(v, { maxChars: 1500 });
		expect(out.length).toBeLessThanOrEqual(1500);
		expect(out).toContain("Folder number 39");
		expect(out).not.toContain("Folder number 00 ");
	});

	it("describes an empty vault without failing", () => {
		const out = describeVault(new FakeVault({}));
		expect(out).toContain("# Vault conventions for the agent");
		expect(out).toContain(DESCRIPTION_START);
	});
});

describe("refreshDescription", () => {
	const draft = describeVault(vault(), { excluded: ["Templates"], conventionsPath: "AGENT.md" });

	it("is the whole draft when there is no note yet", () => {
		expect(refreshDescription(null, draft)).toBe(draft);
		expect(refreshDescription("  \n", draft)).toBe(draft);
	});

	it("replaces only the counted part and keeps every line the user wrote", () => {
		const mine = `# My rules\n\nIntro I wrote.\n\n${DESCRIPTION_START}\n## Folders\n- stale\n${DESCRIPTION_END}\n\n## Never\n- Never touch Finance/.\n`;
		const out = refreshDescription(mine, draft);
		expect(out.startsWith("# My rules\n\nIntro I wrote.\n\n" + DESCRIPTION_START)).toBe(true);
		expect(out.endsWith(DESCRIPTION_END + "\n\n## Never\n- Never touch Finance/.\n")).toBe(true);
		expect(out).toContain("`Daily/` — 20 notes");
		expect(out).not.toContain("- stale");
		// The draft's own Style and Never sections are not pushed into a note that has its own.
		expect(out.match(/## Never/g)).toHaveLength(1);
		// Refreshing again changes nothing.
		expect(refreshDescription(out, draft)).toBe(out);
	});

	it("adds the counted part at the end of a note written by hand", () => {
		const out = refreshDescription("# Conventions\n\n- Never delete recordings.\n", draft);
		expect(out.startsWith("# Conventions\n\n- Never delete recordings.\n\n" + DESCRIPTION_START)).toBe(true);
		expect(out.trimEnd().endsWith(DESCRIPTION_END)).toBe(true);
	});
});
