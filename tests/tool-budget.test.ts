import { describe, expect, it } from "vitest";
import { Agent, newConversation, type AgentConfig } from "../src/agent";
import { keywordSearch } from "../src/search";
import { ALL_TOOLS, findInNote, getActiveNote, grepVault, listFiles, listNotes, listSections, nearestLines, readSection, searchPassages } from "../src/tools";
import type { Passage, ToolContext } from "../src/types";
import { FakeOllama, FakeVault, type Scripted } from "./fakes";

/**
 * The agent replaces the end of a result longer than maxResultChars + 500 with a generic notice.
 * Whatever a tool says last (how many matches are not shown, a verdict, the selection) must
 * therefore fit: these tests make each tool overflow and check that its own last words are there.
 */

function makeCtx(vault: FakeVault, maxResultChars: number): ToolContext {
	return { vault, search: (q, limit) => keywordSearch(vault, q, limit), approve: async () => "approve", maxResultChars };
}

/** A lecture note per course, each with dated sections; every third section has no summary. */
function lectureVault(courses: number, perCourse: number): FakeVault {
	const vault = new FakeVault();
	for (let c = 0; c < courses; c++) {
		const sections = Array.from({ length: perCourse }, (_, i) => {
			const day = `2026-09-${String(i + 1).padStart(2, "0")}`;
			return `## ${day}\n\n![[Recording ${c}-${i}.m4a]]\n\n${i % 3 === 2 ? "- no summary yet" : "### Summary\n\n- point"}\n`;
		});
		vault.seed(`School/Course Number ${c}/Lectures of Course ${c}.md`, `# Lectures ${c}\n\n${sections.join("\n")}`);
	}
	return vault;
}

describe("list_sections within the result budget", () => {
	it("keeps the verdict, the marked list and an exact count of what is not shown", async () => {
		const vault = lectureVault(6, 30);
		const ctx = makeCtx(vault, 3000);
		const out = await listSections.execute({ containing: ["![[Recording", "### Summary"], level: 2, limit: 400 }, ctx);
		expect(out.length).toBeLessThanOrEqual(3000);
		expect(out).toMatch(/^180 sections /);
		// 20 of every 30 sections have both texts.
		expect(out).toMatch(/Sections with EVERY text \(120, the first \d+ listed\):\nSchool\/Course Number 0\/Lectures of Course 0\.md\n {2}## 2026-09-01: /);
		expect(out).toContain("Sections with only SOME of the texts (60");
		expect(out).toMatch(/120 sections marked "→ all" have every text\. These flags are exact/);
		expect(out).toContain("leave the unmarked sections alone.\nMarked sections (path › heading):\nSchool/Course Number 0/Lectures of Course 0.md › 2026-09-01\n");
		expect(out).toMatch(/…and \d+ more$/);
		const listed = (out.match(/^ {2}## /gm) ?? []).length;
		expect(listed).toBeGreaterThan(5);
		expect(out).toContain(`\n…${180 - listed} more sections not shown; narrow with folder/path.\n`);
	});
	it("is unchanged when everything fits", async () => {
		const vault = lectureVault(1, 3);
		const out = await listSections.execute({ containing: ["![[Recording", "### Summary"], level: 2 }, makeCtx(vault, 12000));
		const path = "School/Course Number 0/Lectures of Course 0.md";
		expect(out).toBe(
			[
				'3 sections (flags per text, in order; "→ all" marks a section that has every text):',
				"Sections with EVERY text (2):",
				path,
				"  ## 2026-09-01: ![[Recording yes, ### Summary yes → all",
				"  ## 2026-09-02: ![[Recording yes, ### Summary yes → all",
				'Sections with only SOME of the texts (1) — leave these alone when the rule is "has both":',
				path,
				"  ## 2026-09-03: ![[Recording yes, ### Summary no",
				'2 sections marked "→ all" have every text. These flags are exact: act on the marked sections directly (for example edit_notes with path, heading and line_contains set to the text you searched for), without reading them first, and leave the unmarked sections alone.',
				"Marked sections (path › heading):",
				`${path} › 2026-09-01`,
				`${path} › 2026-09-02`,
			].join("\n"),
		);
	});
	it("counts both groups over every section, not only the ones the limit lets through", async () => {
		const out = await listSections.execute({ containing: ["![[Recording", "### Summary"], level: 2, limit: 6 }, makeCtx(lectureVault(1, 30), 12000));
		expect(out).toMatch(/^30 sections /);
		expect(out).toContain("Sections with EVERY text (20, the first 4 listed):");
		expect(out).toContain("Sections with only SOME of the texts (10, the first 2 listed)");
		expect(out).toContain("\n…24 more sections not shown; narrow with folder/path or raise the limit.\n20 sections marked");
		expect(out).toMatch(/2026-09-05\n…and 16 more$/);
	});
	it("cuts a survey of one heading to fit and says how many sections are left", async () => {
		const vault = new FakeVault();
		for (let i = 0; i < 120; i++) vault.seed(`Daily/2026-${String(i).padStart(3, "0")}.md`, `# Day\n\n## Capture\n\n- thought number ${i} with a few more words to make the row longer\n`);
		const out = await listSections.execute({ heading: "Capture", folder: "Daily" }, makeCtx(vault, 2000));
		expect(out.length).toBeLessThanOrEqual(2000);
		const listed = (out.match(/^ {2}## Capture/gm) ?? []).length;
		expect(listed).toBeGreaterThan(5);
		expect(out.endsWith(`\n…${120 - listed} more sections not shown; narrow with folder/path.`)).toBe(true);
	});
});

describe("grep_vault within the result budget", () => {
	it("keeps the count of matches not shown and the hint when the matches do not fit", async () => {
		const vault = new FakeVault();
		for (let i = 0; i < 40; i++) vault.seed(`Notes/Note ${String(i).padStart(2, "0")}.md`, `## Heading\n\nthe needle is on this line of note ${i}\nfollowed by a context line\n\nand a second needle further down\nwith its own context\n`);
		const out = await grepVault.execute({ pattern: "needle", context: 1 }, makeCtx(vault, 2000));
		expect(out.length).toBeLessThanOrEqual(2000);
		expect(out).toMatch(/^80 matching lines in 40 notes:\nNotes\/Note 00\.md:3 \[## Heading\]: the needle is on this line of note 0\nNotes\/Note 00\.md:4- followed by a context line\n/);
		const shown = (out.match(/^Notes\/Note \d+\.md:\d+ \[## Heading\]: /gm) ?? []).length;
		expect(shown).toBeGreaterThan(5);
		expect(shown).toBeLessThan(60);
		expect(out).toContain(`\n…${80 - shown} more matching lines not shown; narrow with folder or a more specific pattern, or set notes_only: true for every note.\n`);
		expect(out).toMatch(/call list_sections\(\{containing: \["needle", "<other text>"\]\}\) once instead of reading them\.$/);
	});
	it("counts every note with a match, shown or not", async () => {
		const vault = new FakeVault({ "a.md": "needle", "b.md": "needle", "c.md": "needle" });
		const out = await grepVault.execute({ pattern: "needle", limit: 1 }, makeCtx(vault, 12000));
		expect(out).toBe("3 matching lines in 3 notes:\na.md:1: needle\n…2 more matching lines not shown; narrow with folder or raise the limit.");
	});
});

describe("get_active_note within the result budget", () => {
	it("keeps the selection when the note is long, and names the offset where the note text stopped", async () => {
		const content = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
		const vault = new FakeVault({ "Long.md": content });
		vault.activePath = "Long.md";
		vault.selection = "the words the user selected";
		const out = await getActiveNote.execute({}, makeCtx(vault, 2000));
		expect(out.length).toBeLessThanOrEqual(2000);
		expect(out.endsWith("\n\n--- SELECTED TEXT ---\nthe words the user selected")).toBe(true);
		const marker = /\n\n\[TRUNCATED at character (\d+) of (\d+)\. Use read_note with offset=(\d+) to read more\.\]/.exec(out);
		expect(marker).not.toBeNull();
		const shown = out.slice("# Long.md\n---\n".length, marker!.index);
		expect(shown).toBe(content.slice(0, Number(marker![3])));
		expect(Number(marker![2])).toBe(content.length);
	});
	it("cuts a selection longer than half the result and says so", async () => {
		const vault = new FakeVault({ "Long.md": "x".repeat(5000) });
		vault.activePath = "Long.md";
		vault.selection = "s".repeat(4000);
		const out = await getActiveNote.execute({}, makeCtx(vault, 2000));
		expect(out.length).toBeLessThanOrEqual(2000);
		expect(out).toContain("\n\n--- SELECTED TEXT ---\n" + "s".repeat(1000) + "\n[… selection cut at 1000 of 4000 characters]");
		expect(out).toMatch(/\[TRUNCATED at character \d+ of 5000\./);
	});
});

describe("search_passages within the result budget", () => {
	const passage = (i: number, length: number): Passage => ({ path: `Notes/Note ${i}.md`, heading: "Section", crumb: `Topic ${i} › Section`, text: `p${i} `.repeat(Math.ceil(length / 4)).slice(0, length), score: 0.9 - i * 0.01 });
	it("leaves out the lowest-ranked passages rather than cutting the result, and says so first", async () => {
		const vault = new FakeVault();
		const ctx = makeCtx(vault, 12000);
		ctx.searchPassages = async (_q, limit) => Array.from({ length: limit }, (_, i) => passage(i, 2200));
		const out = await searchPassages.execute({ query: "q", limit: 20 }, ctx);
		expect(out.length).toBeLessThanOrEqual(12000);
		const blocks = out.split(/^(?=--- \[\d+\] )/m).slice(1);
		expect(blocks.length).toBeGreaterThanOrEqual(10);
		expect(blocks.length).toBeLessThan(20);
		expect(out.startsWith(`${blocks.length} passages, best first (${20 - blocks.length} lower-ranked left out to fit; ask again with a narrower query for those). Each is one section`)).toBe(true);
		for (const [i, b] of blocks.entries()) {
			const m = /^--- \[(\d+)\] Notes\/Note (\d+)\.md › Topic \d+ › Section \(score 0\.\d\d\)\n([\s\S]*)\n\[… section truncated; read_section for the rest\]\n?$/.exec(b);
			expect(m).not.toBeNull();
			expect(Number(m![1])).toBe(i + 1);
			expect(Number(m![2])).toBe(i);
			expect(m![3].length).toBeGreaterThanOrEqual(600);
		}
	});
	it("shows short passages whole and gives what they leave to the long ones", async () => {
		const ctx = makeCtx(new FakeVault(), 6000);
		const lengths = [300, 5000, 150, 5000];
		ctx.searchPassages = async () => lengths.map((n, i) => passage(i, n));
		const out = await searchPassages.execute({ query: "q" }, ctx);
		expect(out.length).toBeLessThanOrEqual(6000);
		expect(out.length).toBeGreaterThan(5500);
		expect(out).toMatch(/^4 passages, best first\. Each/);
		const blocks = out.split(/^(?=--- \[\d+\] )/m).slice(1);
		expect(blocks[0]).toContain(passage(0, 300).text + "\n");
		expect(blocks[0]).not.toContain("truncated");
		expect(blocks[2]).toContain(passage(2, 150).text + "\n");
		expect(blocks[1]).toContain("[… section truncated; read_section for the rest]");
		expect(blocks[3]).toContain("[… section truncated; read_section for the rest]");
		// The two long ones share the rest evenly.
		expect(Math.abs(blocks[1].length - blocks[3].length)).toBeLessThanOrEqual(2);
	});
	it("is unchanged when everything fits", async () => {
		const ctx = makeCtx(new FakeVault(), 12000);
		ctx.searchPassages = async () => [passage(0, 40), passage(1, 30)];
		expect(await searchPassages.execute({ query: "q" }, ctx)).toBe(
			`2 passages, best first. Each is one section of a note; cite the note path as a wikilink.\n--- [1] Notes/Note 0.md › Topic 0 › Section (score 0.90)\n${passage(0, 40).text}\n--- [2] Notes/Note 1.md › Topic 1 › Section (score 0.89)\n${passage(1, 30).text}`,
		);
	});
});

describe("lists within the result budget", () => {
	it("list_notes says how many notes are not shown when the rows do not fit", async () => {
		const vault = new FakeVault();
		for (let i = 0; i < 300; i++) vault.seed(`A Folder With A Long Name/Another Level/Note number ${String(i).padStart(3, "0")}.md`, "x");
		const out = await listNotes.execute({ limit: 300, sort: "path" }, makeCtx(vault, 4000));
		expect(out.length).toBeLessThanOrEqual(4000);
		const rows = (out.match(/^A Folder.*\.md {2}\(1 B, modified \d{4}-\d\d-\d\d\)$/gm) ?? []).length;
		expect(rows).toBeGreaterThan(20);
		expect(out.endsWith(`\n…and ${300 - rows} more. Narrow the filter.`)).toBe(true);
		// Cut by the limit alone, raising it helps.
		expect(await listNotes.execute({ limit: 2 }, makeCtx(vault, 4000))).toMatch(/\n…and 298 more\. Narrow the filter or raise the limit\.$/);
	});
	it("list_files does the same", async () => {
		const vault = new FakeVault();
		for (let i = 0; i < 200; i++) vault.seedFile(`Recordings/A long recording name ${String(i).padStart(3, "0")}.webm`, 1000);
		const out = await listFiles.execute({ limit: 300 }, makeCtx(vault, 2000));
		expect(out.length).toBeLessThanOrEqual(2000);
		const rows = (out.match(/^Recordings\/.*\.webm {2}\(/gm) ?? []).length;
		expect(out).toMatch(/^200 files:\n/);
		expect(out.endsWith(`\n…and ${200 - rows} more. Narrow the filter.`)).toBe(true);
	});
	it("find_in_note says how many matches are not shown", async () => {
		const vault = new FakeVault({ "Many.md": Array.from({ length: 200 }, (_, i) => `item ${i} with some more words on the line`).join("\n\n") });
		const out = await findInNote.execute({ path: "Many", pattern: "item", limit: 100 }, makeCtx(vault, 2000));
		expect(out.length).toBeLessThanOrEqual(2000);
		const shown = (out.match(/^> +\d+ \| item/gm) ?? []).length;
		expect(shown).toBeGreaterThan(5);
		expect(out.endsWith(`\n…and ${200 - shown} more matches.`)).toBe(true);
	});
});

describe("hints within the result budget", () => {
	it("read_section lists the headings that fit when the one asked for is missing", async () => {
		const vault = new FakeVault({ "Big.md": Array.from({ length: 400 }, (_, i) => `## Heading number ${i}\n\ntext\n`).join("\n") });
		const out = await readSection.execute({ path: "Big", heading: "Zebra" }, makeCtx(vault, 2000));
		expect(out.length).toBeLessThanOrEqual(2000);
		const listed = (out.match(/^## Heading number \d+$/gm) ?? []).length;
		expect(listed).toBeGreaterThan(20);
		expect(out.endsWith(`\n…and ${400 - listed} more; find_in_note with the heading's words finds it.`)).toBe(true);
	});
	it("a failed edit shows the part of a long paragraph around the word, not the whole paragraph", () => {
		const para = `${"Filler sentence. ".repeat(200)}The electromagnet is rated for 12 V. ${"More filler. ".repeat(200)}`;
		const hint = nearestLines(`# T\n\n${para}\n`, "The electromagnet is rated 24 V.");
		expect(hint).toMatch(/^Lines in the note that contain "electromagnet" .*:\n {3}3 \| ….*The electromagnet is rated for 12 V\. .*…$/);
		expect(hint.length).toBeLessThan(600);
	});
});

describe("Sources from a grep with notes_only", () => {
	it("cites the notes that a count-per-note grep listed", async () => {
		const vault = new FakeVault({ "Projects/Chess Robot.md": "The gantry moves pieces with an electromagnet.", "Ideas/Sensors.md": "Hall sensors are cheap." });
		const agent = new Agent({
			client: new FakeOllama([{ tool: "grep_vault", args: { pattern: "electromagnet", notes_only: true } }, { content: "One note mentions it." }]).asClient(),
			vault,
			tools: ALL_TOOLS,
			search: (q, l) => keywordSearch(vault, q, l),
			approve: async () => "approve",
			getConfig: () => ({ model: "fake", numCtx: 8192, temperature: 0, think: undefined, keepAlive: "1m", maxIterations: 4, maxToolResultChars: 4000, autoApprove: false, autoContinue: false, extraSystemPrompt: "" }),
			now: () => new Date(2026, 10, 5, 12),
		});
		const conv = newConversation();
		await agent.run(conv, "which notes mention the electromagnet?", {});
		expect(conv.messages.find((m) => m.role === "tool")?.content).toBe("1 matching line in 1 note (lines per note):\nProjects/Chess Robot.md: 1");
		expect(conv.messages.at(-1)?.content).toBe("One note mentions it.\n\nSources: [[Projects/Chess Robot]]");
	});
});

describe("the agent's own cut", () => {
	const config: AgentConfig = { model: "fake", numCtx: 32768, temperature: 0, think: undefined, keepAlive: "1m", maxIterations: 12, maxToolResultChars: 2000, autoApprove: false, autoContinue: false, extraSystemPrompt: "" };
	it("never has to shorten what these tools return", async () => {
		const vault = lectureVault(6, 45);
		const links = Array.from({ length: 40 }, (_, i) => `[[A Linked Note With A Long Name ${i}]]`).join(" ");
		vault.seed("Hub.md", `${links}\n\n${"word ".repeat(2000)}`);
		for (let i = 0; i < 40; i++) vault.seed(`Linkers/A note that links to the hub ${i}.md`, "See [[Hub]] and the needle.");
		vault.activePath = "Hub.md";
		vault.selection = "selected words";
		const calls: Scripted[] = [
			{ tool: "read_note", args: { path: "Hub" } },
			{ tool: "list_sections", args: { containing: ["![[Recording", "### Summary"] } },
			{ tool: "grep_vault", args: { pattern: "Recording", context: 2, limit: 200 } },
			{ tool: "get_active_note", args: {} },
			{ tool: "list_notes", args: { limit: 300 } },
			{ tool: "find_in_note", args: { path: "School/Course Number 0/Lectures of Course 0", pattern: "#", limit: 100 } },
			{ tool: "read_section", args: { path: "School/Course Number 0/Lectures of Course 0", heading: "Lectures 0" } },
		];
		const agent = new Agent({
			client: new FakeOllama([...calls, { content: "done" }]).asClient(),
			vault,
			tools: ALL_TOOLS,
			search: (q, l) => keywordSearch(vault, q, l),
			approve: async () => "approve",
			getConfig: () => config,
			now: () => new Date(2026, 10, 5, 12),
		});
		const conv = newConversation();
		const results: string[] = [];
		await agent.run(conv, "go", { onToolDone: (_c, result, ok) => results.push(ok ? result : `FAILED ${result}`) });
		expect(results.length).toBe(calls.length);
		for (const r of results) {
			expect(r).not.toMatch(/^FAILED/);
			expect(r).not.toContain("[Result truncated at");
			expect(r.length).toBeLessThanOrEqual(2000);
		}
		expect(results[0]).toMatch(/Call read_note again with offset=\d+ to continue\.\]$/);
		expect(results[1]).toContain("Marked sections (path › heading):");
		expect(results[2]).toMatch(/more matching lines not shown/);
		expect(results[3]).toMatch(/--- SELECTED TEXT ---\nselected words$/);
		expect(results[4]).toMatch(/…and \d+ more\. Narrow the filter\.$/);
		expect(results[5]).toMatch(/…and \d+ more matches\.$/);
		expect(results[6]).toMatch(/Call read_note with offset=\d+ to continue\.\]$/);
	});
});
