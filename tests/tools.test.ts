import { describe, expect, it } from "vitest";
import { keywordSearch } from "../src/search";
import {
	appendToNote,
	clipLine,
	createNote,
	deleteFile,
	editNote,
	editNotes,
	extractSection,
	findInNote,
	getActiveNote,
	grepVault,
	listFiles,
	listNotes,
	listSections,
	localDate,
	looksLikeRegex,
	missingFolderHint,
	missingNoteHint,
	moveNote,
	tidyAlternation,
	nearestLines,
	parseDate,
	readFile,
	normalizeNotePath,
	resolveAny,
	stripOutlineDecoration,
	readNote,
	readSection,
	replaceLine,
	replaceNote,
	replaceSection,
	searchNotes,
	searchPassages,
	vaultOverview,
} from "../src/tools";
import type { ApprovalDecision, ApprovalRequest, ToolContext } from "../src/types";
import { FakeVault } from "./fakes";

/** `maxResultChars` defaults to the plugin's own default: every tool keeps its whole result within it. */
function makeCtx(vault: FakeVault, decision: ApprovalDecision = "approve", maxResultChars = 12000) {
	const approvals: ApprovalRequest[] = [];
	const ctx: ToolContext = {
		vault,
		search: (q, limit) => keywordSearch(vault, q, limit),
		approve: async (req) => {
			approvals.push(req);
			return decision;
		},
		maxResultChars,
	};
	return { ctx, approvals };
}

function freshVault() {
	return new FakeVault({
		"Projects/Chess Robot.md": "---\ntags: [project]\n---\n# Chess Robot\n\nThe gantry moves pieces. See [[Sensors]].\n\n## Status\n\nWorking.",
		"Ideas/Sensors.md": "#hardware\nHall sensors are cheap.",
		"Templates/Daily.md": "template body",
	});
}

describe("normalizeNotePath", () => {
	it("adds .md, strips wikilink brackets and leading slashes", () => {
		expect(normalizeNotePath("/Foo/Bar")).toBe("Foo/Bar.md");
		expect(normalizeNotePath("[[Foo]]")).toBe("Foo.md");
		expect(normalizeNotePath("a\\b.md")).toBe("a/b.md");
	});
	it("rejects traversal and the config folder", () => {
		expect(() => normalizeNotePath("../x")).toThrow();
		expect(() => normalizeNotePath(".obsidian/plugins/x", ".obsidian")).toThrow(/off limits/);
		expect(() => normalizeNotePath("custom-config/plugins/x", "custom-config")).toThrow(/custom-config/);
		expect(normalizeNotePath(".obsidian-notes/x", "custom-config")).toBe(".obsidian-notes/x.md");
	});
});

describe("search_notes", () => {
	it("returns the hits as plain text, best first, in the layout of search_passages", async () => {
		const { ctx } = makeCtx(freshVault());
		const out = await searchNotes.execute({ query: "hall sensors" }, ctx);
		expect(out).toBe(
			"2 notes, best first. Each snippet is a short excerpt, not the note's text.\n--- [1] Ideas/Sensors.md\n#hardware Hall sensors are cheap.\n--- [2] Projects/Chess Robot.md\n--- tags: [project] --- # Chess Robot The gantry moves pieces. See [[Sensors]]. ## Status Working.",
		);
	});
	it("labels a hit with its heading path when the search has one", async () => {
		const { ctx } = makeCtx(freshVault());
		ctx.search = async () => [
			{ path: "School/Lectures.md", score: 0.9, heading: "2026-09-10 › Summary", snippet: "…seven multiplications instead of eight…" },
			{ path: "Ideas/Sensors.md", score: 0.5, snippet: 'A "quoted" snippet stays as it is.' },
		];
		expect(await searchNotes.execute({ query: "strassen" }, ctx)).toBe(
			'2 notes, best first. Each snippet is a short excerpt, not the note\'s text.\n--- [1] School/Lectures.md › 2026-09-10 › Summary\n…seven multiplications instead of eight…\n--- [2] Ideas/Sensors.md\nA "quoted" snippet stays as it is.',
		);
	});
	it("fits the hits to the result budget and counts the ones it shows", async () => {
		const { ctx } = makeCtx(freshVault(), "approve", 1000);
		ctx.search = async (_q, limit) => Array.from({ length: limit }, (_, i) => ({ path: `Notes/Note ${i}.md`, score: 1 - i / 100, snippet: "s".repeat(240) }));
		const out = await searchNotes.execute({ query: "q", limit: 25 }, ctx);
		expect(out.length).toBeLessThanOrEqual(1000);
		expect(out).toMatch(/^3 notes, best first\./);
		expect(out).toContain("--- [3] Notes/Note 2.md\n");
		expect(out).not.toContain("--- [4]");
	});
	it("explains when nothing matches", async () => {
		const { ctx } = makeCtx(freshVault());
		expect(await searchNotes.execute({ query: "zzzz" }, ctx)).toMatch(/No notes matched/);
	});
	it("requires a query", async () => {
		const { ctx } = makeCtx(freshVault());
		await expect(searchNotes.execute({}, ctx)).rejects.toThrow(/query/);
	});
});

describe("read_note", () => {
	it("resolves bare names and includes metadata", async () => {
		const { ctx } = makeCtx(freshVault());
		const out = await readNote.execute({ path: "Chess Robot" }, ctx);
		expect(out).toContain("# Projects/Chess Robot.md");
		expect(out).toContain("links to: Sensors");
		expect(out).toContain("The gantry moves pieces");
	});
	it("pages long notes with offset", async () => {
		const vault = freshVault();
		vault.seed("Long.md", "A".repeat(500));
		const { ctx } = makeCtx(vault, "approve", 200);
		const first = await readNote.execute({ path: "Long.md" }, ctx);
		// The page is what is left of the budget after the header and the marker, never less than a quarter of it.
		expect(first).toContain("[TRUNCATED at character 100 of 500. Call read_note again with offset=100 to continue.]");
		const second = await readNote.execute({ path: "Long.md", offset: 400 }, ctx);
		expect(second).toContain("continuing from character 400");
		expect(second).not.toContain("TRUNCATED");
	});
	it("pages a long note with many links so that every character is seen exactly once", async () => {
		// Numbered words, so a skipped or repeated span cannot go unnoticed.
		const text = Array.from({ length: 9000 }, (_, i) => `w${i}`).join(" ") + " 😀 end";
		const links = Array.from({ length: 40 }, (_, i) => `[[Some Fairly Long Note Name Number ${i}]]`).join(" ");
		for (const limit of [1000, 2000, 12000]) {
			const vault = new FakeVault({ "Hub/Long Hub.md": `#hub ${links}\n\n${text}` });
			for (let i = 0; i < 40; i++) vault.seed(`Linkers/A Note That Links To The Hub ${i}.md`, "See [[Long Hub]].");
			const { ctx } = makeCtx(vault);
			ctx.maxResultChars = limit;
			const content = await vault.read("Hub/Long Hub.md");
			let seen = "";
			let offset = 0;
			for (let calls = 0; calls < 200; calls++) {
				const out = await readNote.execute({ path: "Hub/Long Hub.md", offset }, ctx);
				// Within the budget, so the agent (which cuts above maxResultChars + 500) leaves the marker alone.
				expect(out.length).toBeLessThanOrEqual(limit);
				expect(out).toMatch(/^# Hub\/Long Hub\.md\ntags: .*\nlinks to: .*\nlinked from: .*\nlength: \d+ characters\n---\n/);
				let body = out.slice(out.indexOf("\n---\n") + 5);
				if (offset > 0) {
					expect(body.startsWith(`[…continuing from character ${offset}]\n`)).toBe(true);
					body = body.slice(body.indexOf("\n") + 1);
				}
				const marker = /\n\n\[TRUNCATED at character (\d+) of (\d+)\. Call read_note again with offset=(\d+) to continue\.\]$/.exec(body);
				if (!marker) {
					seen += body;
					break;
				}
				expect(marker[1]).toBe(marker[3]);
				expect(Number(marker[2])).toBe(content.length);
				seen += body.slice(0, marker.index);
				expect(Number(marker[3])).toBe(seen.length);
				offset = Number(marker[3]);
			}
			expect(seen).toBe(content);
		}
	});
	it("says how many links were left out of a long header", async () => {
		const vault = new FakeVault({ "Hub.md": Array.from({ length: 45 }, (_, i) => `[[N${i}]]`).join(" ") });
		const { ctx } = makeCtx(vault);
		ctx.maxResultChars = 12000;
		expect(await readNote.execute({ path: "Hub.md" }, ctx)).toContain("N29, … (+15 more)\n");
	});
	it("fails helpfully for a missing note", async () => {
		const { ctx } = makeCtx(freshVault());
		await expect(readNote.execute({ path: "Nope" }, ctx)).rejects.toThrow(/No note found/);
	});
});

describe("missing-note hints", () => {
	it("lists the notes a small folder actually has when a guessed path misses", async () => {
		const vault = freshVault();
		vault.seed("Daily Notes/2026-10-21.md", "a");
		vault.seed("Daily Notes/2026-10-31.md", "b");
		const { ctx } = makeCtx(vault);
		const err = await readNote.execute({ path: "Daily Notes/2026-10-28.md" }, ctx).catch((e: Error) => e.message);
		expect(err).toMatch(/^No note found for "Daily Notes\/2026-10-28.md"\. "Daily Notes\/" has 2 notes: 2026-10-21.md, 2026-10-31.md\. Use one of these exact paths/);
	});
	it("shows the nearest names and points at list_notes when the folder is large", () => {
		const vault = new FakeVault();
		for (let i = 1; i <= 120; i++) vault.seed(`Daily/2026-01-${String(i).padStart(3, "0")}.md`, "x");
		const hint = missingNoteHint(vault, "Daily/2026-01-050.md");
		expect(hint).toMatch(/"Daily\/" has 120 notes; the nearest by name are/);
		expect(hint).toContain("2026-01-050.md");
		expect(hint).toContain("2026-01-045.md");
		expect(hint).toContain("2026-01-054.md");
		expect(hint).not.toContain("2026-01-001.md");
		expect(hint).toContain('list_notes({folder: "Daily"})');
	});
	it("names the folders that exist and similar notes when the folder has none", () => {
		const vault = freshVault();
		expect(missingNoteHint(vault, "Journal/Chess.md")).toMatch(/no folder "Journal\/".*Similar names: Projects\/Chess Robot.md.*Folders with notes: Ideas\/, Projects\//);
		expect(missingNoteHint(vault, "Zzz")).toMatch(/No note is named "Zzz" in the vault root/);
	});
});

describe("a folder argument that does not exist", () => {
	function vault() {
		const v = freshVault();
		v.seed("Daily/2026-11-01.md", "## Capture\n\n- gantry idea\n");
		v.seed("School/CSCI 406/Lectures.md", "## 2026-09-03\n\ngantry\n");
		v.seedFile("Attachments/scan.pdf", 1000);
		return v;
	}
	it("is named as missing with the closest folders, by every tool that takes one", async () => {
		const { ctx } = makeCtx(vault());
		// A typo, a nested folder asked for by its own name, and a name that only partly matches.
		await expect(grepVault.execute({ pattern: "gantry", folder: "Dialy" }, ctx)).rejects.toThrow('There is no folder "Dialy/". Closest folders: Daily/. Nothing was searched.');
		await expect(grepVault.execute({ pattern: "gantry", folder: "CSCI 406/" }, ctx)).rejects.toThrow('There is no folder "CSCI 406/". Closest folders: School/CSCI 406/. Nothing was searched.');
		await expect(listSections.execute({ heading: "Capture", folder: "Daily Notes" }, ctx)).rejects.toThrow('There is no folder "Daily Notes/". Closest folders: Daily/. Nothing was searched.');
		await expect(listNotes.execute({ folder: "Project" }, ctx)).rejects.toThrow('There is no folder "Project/". Closest folders: Projects/.');
		await expect(listFiles.execute({ folder: "Attachment" }, ctx)).rejects.toThrow('There is no folder "Attachment/". Closest folders: Attachments/.');
		// Nothing like it: the top-level folders.
		await expect(listNotes.execute({ folder: "Zzz/Qqq" }, ctx)).rejects.toThrow('There is no folder "Zzz/Qqq/". Top-level folders: Attachments/, Daily/, Ideas/, Projects/, School/, Templates/.');
	});
	it("is told apart from a folder that exists and has nothing matching", async () => {
		const { ctx } = makeCtx(vault());
		expect(await grepVault.execute({ pattern: "zebra", folder: "daily" }, ctx)).toBe('No note contains "zebra" under daily/.');
		expect(await listSections.execute({ heading: "Nope", folder: "Daily" }, ctx)).toBe('No section headed "nope" under daily/.');
		expect(await listNotes.execute({ folder: "Daily", name_contains: "zebra" }, ctx)).toBe("No notes matched those filters.");
		// A parent folder with notes only in its subfolders, and a folder with attachments but no notes, both exist.
		expect(await listNotes.execute({ folder: "School", name_contains: "zebra" }, ctx)).toBe("No notes matched those filters.");
		expect(await listNotes.execute({ folder: "Attachments" }, ctx)).toBe("No notes matched those filters.");
		expect(await grepVault.execute({ pattern: "gantry", folder: "Attachments" }, ctx)).toBe('No note contains "gantry" under attachments/.');
		expect(await listFiles.execute({ folder: "Daily" }, ctx)).toBe("No attachments matched those filters.");
		expect(missingFolderHint(vault(), "School/CSCI 406")).toBeNull();
		expect(missingFolderHint(vault(), "/school/")).toBeNull();
	});
	it("list_sections takes a note given as the folder, as grep_vault does", async () => {
		const { ctx } = makeCtx(vault());
		expect(await listSections.execute({ heading: "2026", folder: "Lectures" }, ctx)).toMatch(/^1 section .*:\n[\s\S]*With 1 or 2 lines \(1\):\nSchool\/CSCI 406\/Lectures\.md\n {2}## 2026-09-03 \(1 line, 6 chars\): gantry\nEmpty \(0\)$/);
	});
});

describe("list_notes", () => {
	it("filters by folder, tag and name", async () => {
		const { ctx } = makeCtx(freshVault());
		expect(await listNotes.execute({ folder: "Ideas" }, ctx)).toContain("Ideas/Sensors.md");
		expect(await listNotes.execute({ folder: "Ideas" }, ctx)).not.toContain("Chess Robot");
		expect(await listNotes.execute({ tag: "#hardware" }, ctx)).toContain("Ideas/Sensors.md");
		expect(await listNotes.execute({ tag: "project" }, ctx)).toContain("Chess Robot");
		expect(await listNotes.execute({ name_contains: "chess" }, ctx)).toMatch(/^1 note/);
	});
	it("reports overflow", async () => {
		const { ctx } = makeCtx(freshVault());
		expect(await listNotes.execute({ limit: 1 }, ctx)).toContain("and 2 more");
	});
});

describe("vault_overview", () => {
	it("summarizes folders and tags", async () => {
		const { ctx } = makeCtx(freshVault());
		const out = await vaultOverview.execute({}, ctx);
		expect(out).toContain("Total notes: 3");
		expect(out).toContain("Projects/");
		expect(out).toContain("#hardware");
	});
});

describe("get_active_note", () => {
	it("returns the open note and selection", async () => {
		const vault = freshVault();
		vault.activePath = "Ideas/Sensors.md";
		vault.selection = "cheap";
		const { ctx } = makeCtx(vault);
		const out = await getActiveNote.execute({}, ctx);
		expect(out).toContain("# Ideas/Sensors.md");
		expect(out).toContain("SELECTED TEXT");
	});
	it("says when nothing is open", async () => {
		const { ctx } = makeCtx(freshVault());
		expect(await getActiveNote.execute({}, ctx)).toMatch(/No note is currently open/);
	});
});

describe("create_note", () => {
	it("asks for approval then creates", async () => {
		const vault = freshVault();
		const { ctx, approvals } = makeCtx(vault);
		await createNote.execute({ path: "New/Note", content: "hello" }, ctx);
		expect(approvals[0]).toMatchObject({ tool: "create_note", path: "New/Note.md", before: "", after: "hello" });
		expect(await vault.read("New/Note.md")).toBe("hello");
	});
	it("does not write when rejected", async () => {
		const vault = freshVault();
		const { ctx } = makeCtx(vault, "reject");
		await expect(createNote.execute({ path: "X", content: "y" }, ctx)).rejects.toThrow(/rejected/);
		expect(vault.exists("X.md")).toBe(false);
	});
	it("refuses to overwrite", async () => {
		const { ctx } = makeCtx(freshVault());
		await expect(createNote.execute({ path: "Ideas/Sensors", content: "y" }, ctx)).rejects.toThrow(/already exists/);
	});
});

describe("edit_note", () => {
	it("applies a unique replacement after approval", async () => {
		const vault = freshVault();
		const { ctx, approvals } = makeCtx(vault);
		const out = await editNote.execute({ path: "Ideas/Sensors", old_text: "cheap", new_text: "inexpensive" }, ctx);
		expect(out).toContain("1 replacement");
		expect(approvals[0].after).toContain("inexpensive");
		expect(await vault.read("Ideas/Sensors.md")).toContain("inexpensive");
	});
	it("surfaces a non-matching old_text as a tool error", async () => {
		const { ctx } = makeCtx(freshVault());
		await expect(editNote.execute({ path: "Ideas/Sensors", old_text: "zzz", new_text: "" }, ctx)).rejects.toThrow(/not found/);
	});
	it("shows the real lines when old_text was guessed from a snippet", async () => {
		const vault = freshVault();
		vault.seed("Lectures.md", "# Week 1\n\n![[Recording 20260910121426.m4a]]\n\nNotes here.");
		const { ctx } = makeCtx(vault);
		await expect(
			editNote.execute({ path: "Lectures", old_text: "![[Recording 20260910121426.m4a|audio]]", new_text: "" }, ctx),
		).rejects.toThrow(/3 \| !\[\[Recording 20260910121426\.m4a\]\]/);
		expect(nearestLines("a\nb", "zzzz qqqq")).toMatch(/Nothing similar/);
	});
	it("allows deleting text with an empty new_text", async () => {
		const vault = freshVault();
		const { ctx } = makeCtx(vault);
		await editNote.execute({ path: "Ideas/Sensors", old_text: " are cheap", new_text: "" }, ctx);
		expect(await vault.read("Ideas/Sensors.md")).toBe("#hardware\nHall sensors.");
	});
});

describe("append_to_note", () => {
	it("adds a blank line separator and trailing newline", async () => {
		const vault = freshVault();
		const { ctx } = makeCtx(vault);
		await appendToNote.execute({ path: "Ideas/Sensors", content: "More.\n\n" }, ctx);
		expect(await vault.read("Ideas/Sensors.md")).toBe("#hardware\nHall sensors are cheap.\n\nMore.\n");
	});
});

describe("find_in_note", () => {
	it("returns numbered matches with context", async () => {
		const { ctx } = makeCtx(freshVault());
		const out = await findInNote.execute({ path: "Chess Robot", pattern: "GANTRY" }, ctx);
		expect(out).toMatch(/^1 match in Projects\/Chess Robot\.md/);
		expect(out).toContain(">    6 | The gantry moves pieces. See [[Sensors]].");
		expect(out).toContain("     5 | ");
	});
	it("supports regex and reports no match or a bad regex", async () => {
		const { ctx } = makeCtx(freshVault());
		expect(await findInNote.execute({ path: "Chess Robot", pattern: "^## ", regex: true }, ctx)).toContain("| ## Status");
		expect(await findInNote.execute({ path: "Chess Robot", pattern: "zebra" }, ctx)).toMatch(/No lines .* contain "zebra"/);
		const fallback = await findInNote.execute({ path: "Chess Robot", pattern: "[[Sensors", regex: true }, ctx);
		expect(fallback).toMatch(/not a valid regular expression/);
		expect(fallback).toContain("| The gantry moves pieces. See [[Sensors]].");
	});
	it("caps the number of matches", async () => {
		const vault = freshVault();
		vault.seed("Many.md", Array.from({ length: 30 }, (_, i) => `item ${i}`).join("\n"));
		const { ctx } = makeCtx(vault);
		const out = await findInNote.execute({ path: "Many", pattern: "item", limit: 2 }, ctx);
		expect(out).toMatch(/^30 matches/);
		expect(out).toContain("and 28 more matches");
	});
});

describe("delete_file", () => {
	it("moves a note to the trash after approval", async () => {
		const vault = freshVault();
		const { ctx, approvals } = makeCtx(vault);
		const out = await deleteFile.execute({ path: "Ideas/Sensors" }, ctx);
		expect(out).toContain("trash");
		expect(approvals[0]).toMatchObject({ tool: "delete_file", path: "Ideas/Sensors.md", after: "" });
		expect(approvals[0].before).toContain("Hall sensors");
		expect(vault.exists("Ideas/Sensors.md")).toBe(false);
		expect(vault.trashed).toEqual(["Ideas/Sensors.md"]);
	});
	it("deletes attachments by path or bare name", async () => {
		const vault = freshVault();
		vault.seedFile("Recordings/CSCI578 2026-11-05 1717.webm", 2_500_000);
		const { ctx, approvals } = makeCtx(vault);
		await deleteFile.execute({ path: "CSCI578 2026-11-05 1717.webm" }, ctx);
		expect(approvals[0].path).toBe("Recordings/CSCI578 2026-11-05 1717.webm");
		expect(approvals[0].before).toContain("2.5 MB");
		expect(vault.trashed).toEqual(["Recordings/CSCI578 2026-11-05 1717.webm"]);
		expect(vault.listAttachments()).toHaveLength(0);
	});
	it("keeps the file when rejected and explains a missing path", async () => {
		const vault = freshVault();
		const { ctx } = makeCtx(vault, "reject");
		await expect(deleteFile.execute({ path: "Ideas/Sensors" }, ctx)).rejects.toThrow(/rejected/);
		expect(vault.exists("Ideas/Sensors.md")).toBe(true);
		await expect(deleteFile.execute({ path: "nope.webm" }, ctx)).rejects.toThrow(/No file found/);
	});
});

describe("list_files", () => {
	it("lists attachments with filters, newest first", async () => {
		const vault = freshVault();
		vault.seedFile("CSCI578 2026-11-05 1717.webm", 1_000_000);
		vault.seedFile("Attachments/sars_proteins.pdf", 50_000);
		vault.seedFile("Attachments/diagram.png", 2_000);
		const { ctx } = makeCtx(vault);
		const all = await listFiles.execute({}, ctx);
		expect(all).toMatch(/^3 files:/);
		expect(all.indexOf("diagram.png")).toBeLessThan(all.indexOf("sars_proteins.pdf"));
		expect(await listFiles.execute({ extension: ".webm" }, ctx)).toMatch(/^1 file:\nCSCI578 2026-11-05 1717\.webm  \(1\.0 MB/);
		expect(await listFiles.execute({ folder: "/" }, ctx)).not.toContain("Attachments/");
		expect(await listFiles.execute({ folder: "Attachments", name_contains: "SARS" }, ctx)).toContain("sars_proteins.pdf");
		expect(await listFiles.execute({ extension: "mp3" }, ctx)).toMatch(/No attachments/);
	});
});

describe("replace_note", () => {
	it("rewrites after approval", async () => {
		const vault = freshVault();
		const { ctx, approvals } = makeCtx(vault);
		const content = "#hardware\n\n# Sensors\n\nHall sensors are cheap.\n";
		await replaceNote.execute({ path: "Ideas/Sensors", content }, ctx);
		expect(approvals[0].summary).toContain("Rewrite");
		expect(await vault.read("Ideas/Sensors.md")).toBe(content);
	});
	it("refuses to shrink a long note to a stub", async () => {
		const vault = freshVault();
		vault.seed("Big.md", "line\n".repeat(200));
		const { ctx, approvals } = makeCtx(vault);
		await expect(replaceNote.execute({ path: "Big", content: "short" }, ctx)).rejects.toThrow(/less than 30%/);
		expect(approvals).toHaveLength(0);
	});
	it("rejects a rewrite that opens with --- when the note had no frontmatter", async () => {
		const vault = freshVault();
		const { ctx, approvals } = makeCtx(vault);
		await expect(replaceNote.execute({ path: "Ideas/Sensors", content: "---\n# Sensors\n\nHall sensors are cheap.\n" }, ctx)).rejects.toThrow(/starts with '---'/);
		expect(approvals).toHaveLength(0);
		// A note that already has frontmatter may of course keep it.
		const robot = await vault.read("Projects/Chess Robot.md");
		await replaceNote.execute({ path: "Projects/Chess Robot", content: robot + "\nMore.\n" }, ctx);
		expect(approvals).toHaveLength(1);
	});
	it("is a no-op when identical", async () => {
		const vault = freshVault();
		const { ctx, approvals } = makeCtx(vault);
		const out = await replaceNote.execute({ path: "Ideas/Sensors", content: await vault.read("Ideas/Sensors.md") }, ctx);
		expect(out).toMatch(/identical/);
		expect(approvals).toHaveLength(0);
	});
});

describe("search_passages", () => {
	it("returns passages verbatim from the injected passage search", async () => {
		const { ctx } = makeCtx(freshVault());
		ctx.searchPassages = async (q, limit) => [
			{ path: "Projects/Chess Robot.md", heading: "Status", text: `Working. (${q}, ${limit})`, score: 0.81 },
			{ path: "Ideas/Sensors.md", heading: "", text: "Hall sensors are cheap.", score: 0.5 },
		];
		const out = await searchPassages.execute({ query: "gantry status", limit: 2 }, ctx);
		expect(out).toMatch(/^2 passages/);
		expect(out).toContain("--- [1] Projects/Chess Robot.md › Status (score 0.81)\nWorking. (gantry status, 2)");
		expect(out).toContain("--- [2] Ideas/Sensors.md (score 0.50)\nHall sensors are cheap.");
	});
	it("labels a passage with its heading path", async () => {
		const { ctx } = makeCtx(freshVault());
		ctx.searchPassages = async () => [{ path: "School/Lectures.md", heading: "Summary", crumb: "2026-09-10 › Summary", text: "Seven multiplications.", score: 0.8 }];
		expect(await searchPassages.execute({ query: "strassen" }, ctx)).toContain("--- [1] School/Lectures.md › 2026-09-10 › Summary (score 0.80)");
	});
	it("says so when nothing is close and no passage has the question's words", async () => {
		const { ctx } = makeCtx(freshVault());
		ctx.weakMatchBelow = 0.64;
		ctx.searchPassages = async () => [
			{ path: "a.md", heading: "", text: "unrelated", score: 0.58, words: { matched: 1, terms: 3 } },
			{ path: "b.md", heading: "", text: "also unrelated", score: 0.55 },
		];
		const weak = await searchPassages.execute({ query: "how do I renew my passport" }, ctx);
		expect(weak).toMatch(/None of these is a close match \(best score 0\.58\)/);
		expect(weak).toMatch(/say the notes do not cover it/);
		// A close match, a passage with every word, or an embedding model with no measured threshold: no remark.
		ctx.searchPassages = async () => [{ path: "a.md", heading: "", text: "x", score: 0.7 }];
		expect(await searchPassages.execute({ query: "q" }, ctx)).not.toMatch(/close match/);
		ctx.searchPassages = async () => [{ path: "a.md", heading: "", text: "x", score: 0.5, words: { matched: 2, terms: 2 } }];
		expect(await searchPassages.execute({ query: "q" }, ctx)).not.toMatch(/close match/);
		ctx.weakMatchBelow = undefined;
		ctx.searchPassages = async () => [{ path: "a.md", heading: "", text: "x", score: 0.2 }];
		expect(await searchPassages.execute({ query: "q" }, ctx)).not.toMatch(/close match/);
	});
	it("names the question's words that no note contains", async () => {
		const { ctx } = makeCtx(freshVault());
		ctx.searchPassages = async () => [{ path: "Projects/Chess Robot.md", heading: "Decisions", text: "Switch the gantry supply to 24V.", score: 0.7 }];
		ctx.absentWords = (q) => (q.includes("wheels") ? ["wheels"] : []);
		const out = await searchPassages.execute({ query: "chess robot wheels decision" }, ctx);
		expect(out).toMatch(/^1 passage, best first\. .*\nNo note in the vault contains "wheels" \(nor a word that starts the same way\)/);
		expect(out).toContain("say the notes do not cover it");
		expect(out).toContain("--- [1] Projects/Chess Robot.md › Decisions (score 0.70)\nSwitch the gantry supply to 24V.");
		expect(await searchPassages.execute({ query: "gantry supply" }, ctx)).not.toMatch(/No note in the vault/);
	});
	it("falls back to keyword snippets without an index", async () => {
		const { ctx } = makeCtx(freshVault());
		const out = await searchPassages.execute({ query: "hall sensors" }, ctx);
		expect(out).toMatch(/semantic index is not available/);
		expect(out).toContain("Ideas/Sensors.md");
		expect(await searchPassages.execute({ query: "zzzz" }, ctx)).toMatch(/No passages matched/);
	});
});

describe("list_sections given a heading as the text to look for", () => {
	const daily = (capture: string) => `# Day\n\n## Done\n\n- things\n\n## Capture\n\n${capture}\n\n## Tomorrow\n\n- [ ] Laundry\n`;
	const vault = () => {
		const v = freshVault();
		v.seed("Daily/2026-06-01.md", daily(""));
		v.seed("Daily/2026-06-02.md", daily("- an idea about capture cards\n- another line"));
		v.seed("Daily/2026-06-03.md", daily("- call the bank"));
		return v;
	};

	it("surveys the heading when the one text is a heading line or a heading's name", async () => {
		for (const text of ["### Capture", "## Capture", "Capture", "capture"]) {
			const { ctx } = makeCtx(vault());
			const out = await listSections.execute({ containing: [text], folder: "Daily/" }, ctx);
			expect(out, text).toMatch(/^\(containing: \[".*"\] names a heading/);
			expect(out, text).toContain("3 sections (non-empty lines, characters, first line):");
			expect(out, text).toContain("Empty (1): Daily/2026-06-01.md");
			expect(out, text).toContain("## Capture (2 lines");
		}
	});

	it("leaves a text that is not a heading, several texts, and an explicit heading as they were", async () => {
		const { ctx } = makeCtx(vault());
		const laundry = await listSections.execute({ containing: ["Laundry"], folder: "Daily/" }, ctx);
		expect(laundry).not.toMatch(/names a heading/);
		expect(laundry).toContain("## Tomorrow: Laundry yes");
		// "Cap" starts the heading "Capture" but is not a heading itself.
		expect(await listSections.execute({ containing: ["Cap"], folder: "Daily/" }, ctx)).not.toMatch(/names a heading/);
		expect(await listSections.execute({ containing: ["Capture", "Laundry"], folder: "Daily/" }, ctx)).not.toMatch(/names a heading/);
		expect(await listSections.execute({ containing: ["capture cards"], heading: "Capture", folder: "Daily/" }, ctx)).not.toMatch(/names a heading/);
	});
});

describe("read_section / extractSection", () => {
	const note = "# Title\n\nintro\n\n## Status\n\nWorking.\n\n### Detail\n\n```\n## not a heading\n```\n\n## Open problems\n\n- one\n";
	it("extracts a heading and its subsections up to the next heading of the same level", () => {
		const s = extractSection(note, "status");
		expect(s?.text).toBe("## Status\n\nWorking.\n\n### Detail\n\n```\n## not a heading\n```");
		expect(s).toMatchObject({ startLine: 5, endLine: 14 });
		expect(extractSection(note, "Open")?.text).toBe("## Open problems\n\n- one");
		expect(extractSection(note, "nope")).toBeNull();
	});
	it("addresses a repeated heading by the path of headings above it", () => {
		const lectures = "# Lectures\n\n## 2026-09-03\n\n### Summary\n\nfirst\n\n### Transcript\n\nt1\n\n## 2026-09-10\n\n### Summary\n\nsecond\n\n## Summary of the term\n\nall";
		expect(extractSection(lectures, "Summary")?.text).toBe("### Summary\n\nfirst");
		expect(extractSection(lectures, "2026-09-10 › Summary")?.text).toBe("### Summary\n\nsecond");
		expect(extractSection(lectures, "2026-09-10 > summary")?.text).toBe("### Summary\n\nsecond");
		expect(extractSection(lectures, "2026-09-10#Summary")?.text).toBe("### Summary\n\nsecond");
		expect(extractSection(lectures, "Lectures › 2026-09-10 › Summary")?.text).toBe("### Summary\n\nsecond");
		expect(extractSection(lectures, "2026-09 › Transcript")?.text).toBe("### Transcript\n\nt1");
		// No such section under that date: not the same heading from another date.
		expect(extractSection(lectures, "2026-09-10 › Transcript")).toBeNull();
		expect(extractSection(lectures, "2026-12-01 › Summary")).toBeNull();
	});
	it("prefers an exact heading to an earlier one that only starts with the text", () => {
		const n = "## Summary of week\n\na\n\n## Summary\n\nb\n\n## C# notes\n\nc";
		expect(extractSection(n, "Summary")?.text).toBe("## Summary\n\nb");
		expect(extractSection(n, "Summary of")?.text).toBe("## Summary of week\n\na");
		expect(extractSection(n, "C# notes")?.text).toBe("## C# notes\n\nc");
	});
	it("reads a section by prefix and lists headings when missing", async () => {
		const vault = freshVault();
		vault.seed("Long.md", note);
		const { ctx } = makeCtx(vault);
		const out = await readSection.execute({ path: "Long", heading: "open" }, ctx);
		expect(out).toContain("# Long.md (lines 15–18)");
		expect(out).toContain("## Open problems\n\n- one");
		const miss = await readSection.execute({ path: "Long", heading: "Zebra" }, ctx);
		expect(miss).toMatch(/No heading matching "Zebra"/);
		expect(miss).toContain("## Status");
	});
	it("names the read_note offset that continues a section too long for one result", async () => {
		const body = Array.from({ length: 600 }, (_, i) => `s${i}`).join(" ");
		const content = `# T\n\nintro line\n\n## Big\n\n${body}\n\n## After\n\ntail`;
		const vault = new FakeVault({ "Deep/Long.md": content });
		const { ctx } = makeCtx(vault);
		ctx.maxResultChars = 1000;
		const out = await readSection.execute({ path: "Deep/Long", heading: "Big" }, ctx);
		expect(out.length).toBeLessThanOrEqual(1000);
		const marker = /\n\n\[TRUNCATED at (\d+) of (\d+) characters of this section\. Call read_note with offset=(\d+) to continue\.\]$/.exec(out);
		expect(marker).not.toBeNull();
		const shown = out.slice(out.indexOf("\n---\n") + 5, marker!.index);
		expect(shown.length).toBe(Number(marker![1]));
		// The offset is where this page stopped, in the note's own characters.
		expect(content.slice(0, Number(marker![3])).endsWith(shown)).toBe(true);
		const rest = await readNote.execute({ path: "Deep/Long", offset: Number(marker![3]) }, ctx);
		expect(rest).toContain(`[…continuing from character ${marker![3]}]\n${content.slice(Number(marker![3]), Number(marker![3]) + 40)}`);
	});
});

describe("move_note", () => {
	it("moves a note after approval, creating folders, and records the change", async () => {
		const vault = freshVault();
		const { ctx, approvals } = makeCtx(vault);
		const changes: unknown[] = [];
		ctx.recordChange = (c) => changes.push(c);
		const out = await moveNote.execute({ path: "Ideas/Sensors", new_path: "Archive/2025/Sensors" }, ctx);
		expect(out).toContain("Moved Ideas/Sensors.md to Archive/2025/Sensors.md");
		expect(approvals[0]).toMatchObject({ tool: "move_note", before: "Ideas/Sensors.md", after: "Archive/2025/Sensors.md" });
		expect(vault.exists("Archive/2025/Sensors.md")).toBe(true);
		expect(vault.exists("Ideas/Sensors.md")).toBe(false);
		expect(changes[0]).toMatchObject({ tool: "move_note", path: "Archive/2025/Sensors.md", before: "Ideas/Sensors.md" });
	});
	it("moves attachments, refuses collisions and rejections", async () => {
		const vault = freshVault();
		vault.seedFile("rec.webm", 10);
		const { ctx } = makeCtx(vault);
		await moveNote.execute({ path: "rec.webm", new_path: "Recordings/rec.webm" }, ctx);
		expect(vault.listAttachments()[0].path).toBe("Recordings/rec.webm");
		await expect(moveNote.execute({ path: "Ideas/Sensors", new_path: "Projects/Chess Robot" }, ctx)).rejects.toThrow(/already exists/);
		const rejected = makeCtx(vault, "reject");
		await expect(moveNote.execute({ path: "Ideas/Sensors", new_path: "X" }, rejected.ctx)).rejects.toThrow(/rejected/);
		expect(vault.exists("Ideas/Sensors.md")).toBe(true);
	});
});

describe("outline-decorated paths", () => {
	it("strips what a model copies from the outline and still resolves", async () => {
		expect(stripOutlineDecoration("Clubs/MEAL Club.md — MEAL Club › 2026-09-21 meeting › Summary")).toBe("Clubs/MEAL Club.md");
		expect(stripOutlineDecoration("Ideas/Sensors.md #hardware")).toBe("Ideas/Sensors.md");
		expect(stripOutlineDecoration("Ideas/Sensors.md (+3)")).toBe("Ideas/Sensors.md");
		const vault = freshVault();
		vault.seedFile("rec.webm", 5);
		expect(resolveAny(vault, "Ideas/Sensors.md — Sensors › Notes")).toBe("Ideas/Sensors.md");
		expect(resolveAny(vault, "rec.webm — recording")).toBe("rec.webm");
		const { ctx } = makeCtx(vault);
		const out = await readNote.execute({ path: "Projects/Chess Robot.md — Chess Robot › Status" }, ctx);
		expect(out).toContain("# Projects/Chess Robot.md");
	});
});

describe("read_note dedupe", () => {
	it("short-circuits a repeat read of an unchanged note within a turn", async () => {
		const vault = freshVault();
		const { ctx } = makeCtx(vault, "approve", 200);
		ctx.readLog = new Map();
		const first = await readNote.execute({ path: "Ideas/Sensors" }, ctx);
		expect(first).toContain("Hall sensors are cheap.");
		const second = await readNote.execute({ path: "Ideas/Sensors" }, ctx);
		expect(second).toMatch(/^\(unchanged since you read Ideas\/Sensors\.md/);
		await vault.modify("Ideas/Sensors.md", "#hardware\nHall sensors are pricey.");
		expect(await readNote.execute({ path: "Ideas/Sensors" }, ctx)).toContain("pricey");
		// Paged (truncated) reads are never deduped.
		vault.seed("Long.md", "A".repeat(500));
		await readNote.execute({ path: "Long.md" }, ctx);
		expect(await readNote.execute({ path: "Long.md" }, ctx)).toContain("TRUNCATED");
	});
});

describe("list_notes date filters", () => {
	it("filters by modified_after / modified_before", async () => {
		const vault = new FakeVault();
		vault.seed("Old.md", "x", new Date(2026, 0, 10).getTime());
		vault.seed("New.md", "y", new Date(2026, 9, 20).getTime());
		const { ctx } = makeCtx(vault);
		expect(await listNotes.execute({ modified_after: "2026-06-01" }, ctx)).toMatch(/^1 note:\nNew\.md/);
		expect(await listNotes.execute({ modified_before: "2026-06-01" }, ctx)).toMatch(/^1 note:\nOld\.md/);
		expect(await listNotes.execute({ modified_after: "2026-01-10", modified_before: "2026-01-11" }, ctx)).toContain("Old.md");
		expect(parseDate("")).toBeNull();
		expect(parseDate("garbage")).toBeNull();
	});
	it("prints the date a note was modified on the user's calendar, the one the filters use", async () => {
		const vault = new FakeVault();
		// Late evening and just after midnight, local time: in UTC one of the two falls on another day in every zone but UTC itself.
		vault.seed("Evening.md", "x", new Date(2026, 10, 5, 23, 30).getTime());
		vault.seed("Small hours.md", "y", new Date(2026, 10, 5, 0, 30).getTime());
		vault.seedFile("Recording.webm", 1000, new Date(2026, 10, 5, 23, 30).getTime());
		const { ctx } = makeCtx(vault);
		const out = await listNotes.execute({ modified_after: "2026-11-05", modified_before: "2026-11-06" }, ctx);
		expect(out).toBe("2 notes:\nEvening.md  (1 B, modified 2026-11-05)\nSmall hours.md  (1 B, modified 2026-11-05)");
		expect(await listNotes.execute({ modified_after: "2026-11-06" }, ctx)).toBe("No notes matched those filters.");
		expect(await listFiles.execute({}, ctx)).toBe("1 file:\nRecording.webm  (1 kB, modified 2026-11-05)");
		expect(localDate(new Date(2026, 0, 1, 0, 0, 1))).toBe("2026-01-01");
		expect(localDate(new Date(2026, 11, 31, 23, 59, 59).getTime())).toBe("2026-12-31");
		// The date printed is one that modified_after reads back as the same day.
		expect(localDate(parseDate("2026-03-08")!)).toBe("2026-03-08");
	});
});

describe("read_file", () => {
	it("returns extracted text for attachments and refuses notes", async () => {
		const vault = freshVault();
		vault.seedFile("Attachments/slides.pdf", 1000);
		const { ctx } = makeCtx(vault);
		await expect(readFile.execute({ path: "Attachments/slides.pdf" }, ctx)).rejects.toThrow(/not available/);
		ctx.readAttachmentText = async (p) => `--- Page 1 ---\nIsolation forests isolate anomalies (${p})`;
		const out = await readFile.execute({ path: "slides.pdf" }, ctx);
		expect(out).toContain("# Attachments/slides.pdf");
		expect(out).toContain("Isolation forests");
		await expect(readFile.execute({ path: "Ideas/Sensors" }, ctx)).rejects.toThrow(/use read_note/);
		await expect(readFile.execute({ path: "nope.pdf" }, ctx)).rejects.toThrow(/No file found/);
	});
	it("pages a long attachment within the budget, the scanned-pages note included", async () => {
		const vault = freshVault();
		vault.seedFile("Attachments/A Rather Long Folder Name/slides for the whole semester.pdf", 1000);
		const { ctx } = makeCtx(vault);
		ctx.maxResultChars = 1500;
		ctx.describeImage = async () => "";
		const text = "--- Page 1 ---\n\n--- Page 2 ---\n" + Array.from({ length: 2000 }, (_, i) => `t${i}`).join(" ");
		ctx.readAttachmentText = async () => text;
		let seen = "";
		let offset = 0;
		for (let calls = 0; calls < 50; calls++) {
			const out = await readFile.execute({ path: "slides for the whole semester.pdf", offset }, ctx);
			expect(out.length).toBeLessThanOrEqual(1500);
			if (offset === 0) expect(out).toContain("[Page 1 has no text layer (scanned).");
			const body = out.slice(out.indexOf("\n---\n") + 5).replace(/\n\n\[Page 1 has no text layer[^\]]*\]/, "");
			const marker = /\n\n\[TRUNCATED at character (\d+) of \d+\. Call read_file again with offset=(\d+) to continue\.\]$/.exec(body);
			if (!marker) {
				seen += body;
				break;
			}
			seen += body.slice(0, marker.index);
			offset = Number(marker[2]);
			expect(offset).toBe(seen.length);
		}
		expect(seen).toBe(text);
	});
});

describe("grep_vault", () => {
	it("finds lines across notes with context and folder filter", async () => {
		const vault = freshVault();
		vault.seed("School/Lectures.md", "# L\n\n## 2026-09-03\n\n![[Recording 1.m4a]]\n\n### Summary\n\n- x\n\n## 2026-09-10\n\n![[Recording 2.m4a]]\n\n- no summary\n");
		vault.seed("Clubs/Club.md", "## meeting\n\n![[Recording 3.m4a]]\n");
		const { ctx } = makeCtx(vault);
		const out = await grepVault.execute({ pattern: "![[Recording", context: 2 }, ctx);
		expect(out).toMatch(/^3 matching lines in 2 notes:/);
		expect(out).toContain("School/Lectures.md:5 [## 2026-09-03]: ![[Recording 1.m4a]]");
		expect(out).toContain("School/Lectures.md:13 [## 2026-09-10]: ![[Recording 2.m4a]]");
		expect(out).toContain("School/Lectures.md:7- ### Summary");
		expect(out).toContain("Clubs/Club.md:3 [## meeting]: ![[Recording 3.m4a]]");
		expect(await grepVault.execute({ pattern: "recording", folder: "Clubs" }, ctx)).toMatch(/^1 matching line in 1 note/);
		expect(await grepVault.execute({ pattern: "^## 2026", regex: true }, ctx)).toMatch(/^2 matching lines/);
		expect(await grepVault.execute({ pattern: "zebra" }, ctx)).toMatch(/^No note contains/);
		expect(await grepVault.execute({ pattern: "Recording", limit: 1 }, ctx)).toContain("2 more matching lines");
	});

	it("searches a regex-looking pattern as a regex when the literal search finds nothing", async () => {
		const vault = freshVault();
		vault.seed("Daily/d1.md", "## Capture\n\n> Quoted thought\n\n```bash\nscp a b\n```\n");
		const { ctx } = makeCtx(vault);
		const quotes = await grepVault.execute({ pattern: "^\\s*>\\s+[A-Z]", regex: false }, ctx);
		expect(quotes).toMatch(/^\(No line contains that text literally; it looks like a regular expression, so it was searched as one\.\)\n1 matching line/);
		expect(quotes).toContain("Daily/d1.md:3 [## Capture]: > Quoted thought");
		const fences = await grepVault.execute({ pattern: "```bash|```python" }, ctx);
		expect(fences).toMatch(/1 matching line/);
		const spaced = await grepVault.execute({ pattern: "scp | salloc | module load" }, ctx);
		expect(spaced).toContain('as "scp|salloc|module load"');
		expect(spaced).toContain("Daily/d1.md:6");
		// A literal hit still wins, and a genuine miss says both were tried.
		expect(await grepVault.execute({ pattern: "a b" }, ctx)).toMatch(/^1 matching line/);
		expect(await grepVault.execute({ pattern: "^zebra|yak$" }, ctx)).toMatch(/^\(Searched both as literal text and as a regular expression\.\)\nNo note contains/);
		expect(looksLikeRegex("plain words")).toBe(false);
		expect(looksLikeRegex("[[Embed")).toBe(false);
		// A model that escapes the brackets of an embed meant a regex.
		vault.seed("Daily/d2.md", "![[Recording 1.m4a]]\n");
		expect(await grepVault.execute({ pattern: "!\\[\\[Recording" }, ctx)).toMatch(/searched as one.*\n1 matching line/s);
		expect(tidyAlternation("a|b")).toBe("a|b");
	});
});

describe("grep_vault long lines and notes_only", () => {
	// A prose paragraph is one line: 3,000 characters with the word two thirds of the way in.
	const paragraph = (i: number) => `${"Filler sentence about nothing in particular. ".repeat(44)}Then the gantry${i} appears in the middle. ${"More filler after the match, on and on. ".repeat(25)}`;
	it("cuts a long line to a window around the match, marked with …", async () => {
		const vault = new FakeVault({ "Prose/Essay.md": `## Body\n\n${paragraph(7)}\n\nshort line with gantry7\n` });
		const { ctx } = makeCtx(vault);
		const out = await grepVault.execute({ pattern: "GANTRY7", context: 1 }, ctx);
		const rows = out.split("\n");
		expect(rows[0]).toBe("2 matching lines in 1 note:");
		expect(rows[1]).toMatch(/^Prose\/Essay\.md:3 \[## Body\]: ….*Then the gantry7 appears in the middle\. .*…$/);
		expect(rows[1].length).toBeLessThan(300);
		// Context lines and short matching lines are not cut.
		expect(rows[2]).toBe("Prose/Essay.md:4- ");
		expect(rows[3]).toBe("Prose/Essay.md:5 [## Body]: short line with gantry7");
		// A regular expression is cut around where it matched, too.
		const re = await grepVault.execute({ pattern: "gantry\\d appears", regex: true }, ctx);
		expect(re).toMatch(/^1 matching line in 1 note:\nProse\/Essay\.md:3 \[## Body\]: ….*gantry7 appears.*…$/);
	});
	it("shows every match of a prose vault where whole paragraphs would not fit", async () => {
		const vault = new FakeVault();
		for (let i = 0; i < 30; i++) vault.seed(`Prose/Essay ${String(i).padStart(2, "0")}.md`, paragraph(i));
		const { ctx } = makeCtx(vault);
		const out = await grepVault.execute({ pattern: "gantry" }, ctx);
		expect(out.length).toBeLessThanOrEqual(12000);
		expect(out).toMatch(/^30 matching lines in 30 notes:/);
		for (let i = 0; i < 30; i++) expect(out).toContain(`the gantry${i} appears`);
		expect(out).not.toContain("more matching lines");
	});
	it("lists only the notes with their counts when notes_only is set", async () => {
		const vault = new FakeVault({ "A/one.md": "gantry\nx\ngantry again\nGantry", "B/two.md": "nothing", "B/three.md": "a gantry", "A/four.md": "gantry\ngantry" });
		const { ctx } = makeCtx(vault);
		expect(await grepVault.execute({ pattern: "gantry", notes_only: true }, ctx)).toBe("6 matching lines in 3 notes (lines per note):\nA/one.md: 3\nA/four.md: 2\nB/three.md: 1");
		expect(await grepVault.execute({ pattern: "gantry", notes_only: "true", folder: "B" }, ctx)).toBe("1 matching line in 1 note (lines per note):\nB/three.md: 1");
		expect(await grepVault.execute({ pattern: "zebra", notes_only: true }, ctx)).toMatch(/^No note contains "zebra"/);
		// The limit is about lines; it does not hide notes here.
		expect(await grepVault.execute({ pattern: "gantry", notes_only: true, limit: 1 }, ctx)).toContain("B/three.md: 1");
	});
	it("fits a long list of notes and says how many are left", async () => {
		const vault = new FakeVault();
		for (let i = 0; i < 200; i++) vault.seed(`Some Folder/Some Note With A Long Name ${String(i).padStart(3, "0")}.md`, "needle");
		const { ctx } = makeCtx(vault, "approve", 2000);
		const out = await grepVault.execute({ pattern: "needle", notes_only: true }, ctx);
		expect(out.length).toBeLessThanOrEqual(2000);
		const rows = (out.match(/\.md: 1$/gm) ?? []).length;
		expect(rows).toBeGreaterThan(20);
		expect(out.endsWith(`\n…and ${200 - rows} more notes; narrow with folder.`)).toBe(true);
		// The lines mode points at it when the lines do not fit.
		expect(await grepVault.execute({ pattern: "needle", limit: 200 }, ctx)).toMatch(/more matching lines not shown; narrow with folder or a more specific pattern, or set notes_only: true for every note\.$/);
	});
	it("clipLine keeps short lines whole and the match inside the window", () => {
		expect(clipLine("short", 240, 2)).toBe("short");
		const nearlyFits = "x".repeat(270);
		expect(clipLine(nearlyFits, 240, 100)).toBe(nearlyFits);
		const line = `${"a ".repeat(500)}NEEDLE${" b".repeat(500)}`;
		const cut = clipLine(line, 240, 1000);
		expect(cut.startsWith("…")).toBe(true);
		expect(cut.endsWith("…")).toBe(true);
		expect(cut.length).toBeLessThanOrEqual(242);
		expect(cut.indexOf("NEEDLE")).toBeGreaterThan(40);
		// At the start nothing is cut in front; at the end nothing behind.
		expect(clipLine(line, 240, 3)).toBe(line.slice(0, 240) + "…");
		expect(clipLine(`${"a ".repeat(500)}NEEDLE`, 240, 1000)).toBe("…" + `${"a ".repeat(500)}NEEDLE`.slice(-240));
	});
});

describe("find_in_note long lines", () => {
	it("shows the part of a long paragraph around the match and the start of its neighbours", async () => {
		const before = "Before. ".repeat(100);
		const para = `${"Filler sentence. ".repeat(100)}The exact phrase to edit is here. ${"Trailing words. ".repeat(100)}`;
		const vault = new FakeVault({ "Essay.md": `${before}\n${para}\nshort after` });
		const { ctx } = makeCtx(vault);
		const out = await findInNote.execute({ path: "Essay", pattern: "exact phrase" }, ctx);
		const rows = out.split("\n");
		expect(rows[0]).toBe('1 match in Essay.md (3 lines). The matching line is marked with ">".');
		expect(rows[1]).toBe(`     1 | ${before.slice(0, 160)}…`);
		expect(rows[2]).toMatch(/^> {4}2 \| ….*The exact phrase to edit is here\. .*…$/);
		expect(rows[2].length).toBeLessThan(420);
		expect(rows[3]).toBe("     3 | short after");
	});
});

describe("replace_section", () => {
	const note = "# 2026-09-21\n\nMood: ok.\n\n## Done\n\n- HW\n\n## Capture\n\nFellowships:\n- NDSEG due Oct 30\n> quote\n\n## Tomorrow\n\n- [ ] Read\n";

	it("replaces the body under a heading, keeps the heading and the rest, asks for approval and records undo", async () => {
		const vault = new FakeVault({ "Daily/2026-09-21.md": note });
		const { ctx, approvals } = makeCtx(vault);
		const changes: { tool: string }[] = [];
		ctx.recordChange = (c) => changes.push(c);
		const out = await replaceSection.execute({ path: "Daily/2026-09-21.md", heading: "Capture", new_text: "- Moved to [[Topics/Fellowships]]" }, ctx);
		expect(out).toMatch(/^Replaced the "Capture" section/);
		expect(await vault.read("Daily/2026-09-21.md")).toBe("# 2026-09-21\n\nMood: ok.\n\n## Done\n\n- HW\n\n## Capture\n\n- Moved to [[Topics/Fellowships]]\n\n## Tomorrow\n\n- [ ] Read\n");
		expect(approvals[0].summary).toBe('Replace section "Capture" in Daily/2026-09-21.md');
		expect(changes[0].tool).toBe("replace_section");
	});

	it("empties a section, handles the last section, and reports a missing heading", async () => {
		const vault = new FakeVault({ "N.md": note });
		const { ctx } = makeCtx(vault);
		await replaceSection.execute({ path: "N.md", heading: "capture", new_text: "" }, ctx);
		expect(await vault.read("N.md")).toContain("## Capture\n\n## Tomorrow");
		await replaceSection.execute({ path: "N.md", heading: "Tomorrow", new_text: "- [ ] Sleep\n\n" }, ctx);
		expect(await vault.read("N.md")).toMatch(/## Tomorrow\n\n- \[ \] Sleep\n$/);
		await expect(replaceSection.execute({ path: "N.md", heading: "Nope", new_text: "x" }, ctx)).rejects.toThrow(/No heading matching "Nope".*## Capture/s);
		expect(await replaceSection.execute({ path: "N.md", heading: "Tomorrow", new_text: "- [ ] Sleep" }, ctx)).toMatch(/already has that content/);
	});

	it("does not write when rejected", async () => {
		const vault = new FakeVault({ "N.md": note });
		const { ctx } = makeCtx(vault, "reject");
		await expect(replaceSection.execute({ path: "N.md", heading: "Capture", new_text: "gone" }, ctx)).rejects.toThrow(/rejected/);
		expect(await vault.read("N.md")).toBe(note);
	});
});

describe("list_notes sizes", () => {
	it("shows each note's size so empty notes can be skipped", async () => {
		const vault = freshVault();
		vault.seed("Daily/empty.md", "# Day\n\n## Capture\n");
		vault.seed("Daily/full.md", "# Day\n\n## Capture\n\n" + "words ".repeat(400));
		const { ctx } = makeCtx(vault);
		const out = await listNotes.execute({ folder: "Daily" }, ctx);
		expect(out).toMatch(/Daily\/empty\.md  \(18 B, modified/);
		expect(out).toMatch(/Daily\/full\.md  \(2 kB, modified/);
	});
});

describe("edit_notes", () => {
	it("groups edits by note, one approval per note, reports failures and records undo", async () => {
		const vault = freshVault();
		vault.seed("L.md", "# L\n\n## a\n\n![[Recording 1.m4a]]\n\n### Summary\n\n## b\n\n![[Recording 2.m4a]]\n");
		const { ctx, approvals } = makeCtx(vault);
		const changes: unknown[] = [];
		ctx.recordChange = (c) => changes.push(c);
		const out = await editNotes.execute(
			{
				edits: [
					{ path: "L", old_text: "![[Recording 1.m4a]]\n\n", new_text: "" },
					{ path: "L", old_text: "![[Recording 2.m4a]]\n", new_text: "" },
					{ path: "Ideas/Sensors", old_text: "cheap", new_text: "pricey" },
					{ path: "Ideas/Sensors", old_text: "nonexistent 20260101.m4a", new_text: "" },
					{ path: "Nope", old_text: "x", new_text: "y" },
				],
			},
			ctx,
		);
		expect(out).toMatch(/^3 of 5 edits applied\./);
		expect(out).toContain("L.md: applied edits #1, #2.");
		expect(out).toContain("Ideas/Sensors.md: applied edit #3.");
		expect(out).toMatch(/#4 Ideas\/Sensors\.md: old_text was not found/);
		expect(out).toMatch(/#5 Nope: No note found/);
		expect(approvals.map((a) => a.path)).toEqual(["L.md", "Ideas/Sensors.md"]);
		expect(await vault.read("L.md")).toBe("# L\n\n## a\n\n### Summary\n\n## b\n\n");
		expect(await vault.read("Ideas/Sensors.md")).toContain("pricey");
		expect(changes).toHaveLength(2);
	});
	it("stops at a rejection and validates input", async () => {
		const vault = freshVault();
		const { ctx } = makeCtx(vault, "reject");
		const out = await editNotes.execute({ edits: [{ path: "Ideas/Sensors", old_text: "cheap", new_text: "x" }, { path: "Projects/Chess Robot", old_text: "Working.", new_text: "Done." }] }, ctx);
		expect(out).toMatch(/^0 of 2 edits applied/);
		expect(out).toContain("Stopped: the user rejected a change");
		expect(await vault.read("Projects/Chess Robot.md")).toContain("Working.");
		await expect(editNotes.execute({ edits: [] }, ctx)).rejects.toThrow(/non-empty/);
	});
});

describe("edit_notes line_contains", () => {
	it("replaces or deletes one identified line, scoped to a heading", async () => {
		const vault = freshVault();
		vault.seed("L.md", "# L\n\n## a\n\n![[Recording 1.m4a]]\n\n### Summary\n\n- x\n\n## b\n\n![[Recording 2.m4a]]\n\n- y\n");
		const { ctx, approvals } = makeCtx(vault);
		const out = await editNotes.execute(
			{
				edits: [
					{ path: "L", heading: "a", line_contains: "![[Recording", new_text: "" },
					{ path: "L", line_contains: "Recording 2", new_text: "(recording removed)" },
					{ path: "L", line_contains: "zzz", new_text: "" },
					{ path: "L", line_contains: "- ", new_text: "" },
				],
			},
			ctx,
		);
		expect(out).toMatch(/^2 of 4 edits applied/);
		expect(out).toMatch(/#3 L\.md: no line contains "zzz"/);
		expect(out).toMatch(/#4 L\.md: "-" occurs on 2 lines \(7, 13\)/);
		expect(approvals).toHaveLength(1);
		expect(await vault.read("L.md")).toBe("# L\n\n## a\n\n### Summary\n\n- x\n\n## b\n\n(recording removed)\n\n- y\n");
		expect(replaceLine("a\nb", "q", "", "nope")).toMatchObject({ ok: false });
	});
});

describe("list_sections", () => {
	it("marks sections that contain every text and says to act on them without reading", async () => {
		const vault = freshVault();
		vault.seed("S/L.md", "# L\n\n## a\n\n![[Recording 1.m4a]]\n\n### Summary\n\n- x\n\n## b\n\n![[Recording 2.m4a]]\n\n- no summary\n");
		const { ctx } = makeCtx(vault);
		const out = await listSections.execute({ containing: ["![[Recording", "### Summary"], folder: "S", level: 2 }, ctx);
		expect(out).toContain("## a: ![[Recording yes, ### Summary yes → all");
		expect(out).toContain("## b: ![[Recording yes, ### Summary no\n");
		expect(out).toMatch(/1 section marked "→ all" has every text\. These flags are exact/);
		expect(out).toMatch(/leave the unmarked sections alone/);
		expect(out).toMatch(/Marked sections \(path › heading\):\nS\/L\.md › a$/m);
	});

	it("leaves out a parent section whose match comes only from a child", async () => {
		const vault = freshVault();
		vault.seed("S/L.md", "# Lectures\n\nIntro.\n\n## a\n\n![[Recording 1.m4a]]\n\n### Summary\n\n- x\n\n## b\n\n![[Recording 2.m4a]]\n");
		const { ctx } = makeCtx(vault);
		const out = await listSections.execute({ containing: ["![[Recording", "### Summary"], folder: "S" }, ctx);
		expect(out).not.toContain("# Lectures");
		expect(out).toContain("## a: ![[Recording yes, ### Summary yes → all");
		expect(out).toContain("## b: ![[Recording yes, ### Summary no");
		expect(out).toMatch(/^2 sections/);
	});

	it("accepts the texts as a Python-style list in a string", async () => {
		const vault = freshVault();
		vault.seed("S/L.md", "# L\n\n## a\n\n![[Recording 1.m4a]]\n\n### Summary\n\n- x\n");
		const { ctx } = makeCtx(vault);
		const out = await listSections.execute({ containing: "['![[Recording', '### Summary']", folder: "S", level: 2 }, ctx);
		expect(out).toContain("## a: ![[Recording yes, ### Summary yes → all");
	});

	it("surveys a year of daily notes in a few thousand characters, with every count exact", async () => {
		const vault = new FakeVault({});
		for (let i = 0; i < 300; i++) {
			const day = `Daily/2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}.md`;
			const body = i % 50 === 0 ? "- workshop notes\n- who to email\n- a third line\n- a fourth" : i % 10 === 0 ? "- call the bank" : "";
			vault.seed(day, `# Day\n\n## Capture\n\n${body}\n\n## Tomorrow\n\n- [ ] Laundry\n`);
		}
		const { ctx } = makeCtx(vault);
		const out = await listSections.execute({ heading: "Capture", folder: "Daily", limit: 400 }, ctx);
		expect(out.length).toBeLessThanOrEqual(12000);
		expect(out).toMatch(/^300 sections \(non-empty lines, characters, first line\):\nWith 3 or more lines \(6\):/);
		expect(out).toContain("With 1 or 2 lines (24):");
		// The 270 empty ones cost a name each while there is room, then a count.
		expect(out).toMatch(/Empty \(270\): Daily\/2026-01-02\.md, .* \(\+\d+ more notes\)$/);
		expect(out.match(/## Capture \(/g)).toHaveLength(30);
		expect(out).not.toContain("more sections not shown");
	});

	it("treats a containing text that is just the heading as the heading, and surveys", async () => {
		const vault = freshVault();
		vault.seed("Daily/2026-11-01.md", "# D\n\n## Capture\n\n- one\n- two\n");
		vault.seed("Daily/2026-11-02.md", "# D\n\n## Capture\n");
		const { ctx } = makeCtx(vault);
		const out = await listSections.execute({ containing: ["## Capture"], heading: "Capture", folder: "Daily/" }, ctx);
		expect(out).toMatch(/^2 sections \(non-empty lines/);
		expect(out).toContain("## Capture (2 lines");
		expect(out).toContain("Empty (1): Daily/2026-11-02.md");
	});

	it("says the sections exist when none contains the texts, instead of 'no section'", async () => {
		const vault = freshVault();
		vault.seed("Daily/2026-11-01.md", "# D\n\n## Capture\n\n- one\n");
		const { ctx } = makeCtx(vault);
		const out = await listSections.execute({ containing: ["B-cell"], heading: "Capture", folder: "Daily" }, ctx);
		expect(out).toMatch(/^1 section headed "capture" under daily\/ exists?, but none contains "B-cell"/);
		expect(await listSections.execute({ containing: ["B-cell"], heading: "Nope", folder: "Daily" }, ctx)).toMatch(/^No section headed "nope"/);
	});

	it("flags which sections contain each text", async () => {
		const vault = freshVault();
		vault.seed("S/L.md", "# L\n\n## a\n\n![[Recording 1.m4a]]\n\n### Summary\n\n- x\n\n## b\n\n![[Recording 2.m4a]]\n\n## c\n\nnothing\n");
		const { ctx } = makeCtx(vault);
		const out = await listSections.execute({ containing: ["![[Recording", "### Summary"], folder: "S", level: 2 }, ctx);
		expect(out).toMatch(/^2 sections/);
		expect(out).toContain("Sections with EVERY text (1):\nS/L.md\n  ## a: ![[Recording yes, ### Summary yes → all\n");
		expect(out).toContain('Sections with only SOME of the texts (1) — leave these alone when the rule is "has both":\nS/L.md\n  ## b: ![[Recording yes, ### Summary no');
		expect(out).not.toContain("## c");
		const all = await listSections.execute({ containing: ["zzz"], path: "S/L", only_matching: false }, ctx);
		expect(all).toMatch(/^5 sections/);
		expect(await listSections.execute({ containing: ["zzz"] }, ctx)).toMatch(/^\d+ sections exist, but none contains "zzz"/);
		await expect(listSections.execute({ containing: [] }, ctx)).rejects.toThrow(/heading.*containing/);
	});

	it("surveys one heading across notes with size and first line", async () => {
		const vault = new FakeVault({
			"Daily/a.md": "# a\n\n## Done\n\n- x\n\n## Capture\n\nFellowships from the talk:\n- NDSEG\n- GEM\n\n## Tomorrow\n",
			"Daily/b.md": "# b\n\n## Capture\n\n## Tomorrow\n\n- [ ] y\n",
			"Daily/c.md": "# c\n\n## Captured thoughts\n\n> one quote\n",
			"Other/d.md": "## Capture\n\nnot in the folder\n",
		});
		const { ctx } = makeCtx(vault);
		const out = await listSections.execute({ heading: "capture", folder: "Daily" }, ctx);
		// Three groups by how much is under the heading, so "which have real content" is read off, not judged from counts.
		expect(out).toBe(
			[
				"3 sections (non-empty lines, characters, first line):",
				"With 3 or more lines (1):",
				"Daily/a.md",
				"  ## Capture (3 lines, 40 chars): Fellowships from the talk:",
				"With 1 or 2 lines (1):",
				"Daily/c.md",
				"  ## Captured thoughts (1 line, 11 chars): > one quote",
				"Empty (1): Daily/b.md",
			].join("\n"),
		);
		expect(out).not.toContain("Other/d.md");
		const both = await listSections.execute({ heading: "Capture", containing: ["NDSEG"], folder: "Daily" }, ctx);
		expect(both).toContain("## Capture (3 lines, 40 chars): Fellowships from the talk: | NDSEG yes");
		expect(both).not.toContain("Daily/b.md");
		expect(await listSections.execute({ heading: "Nope" }, ctx)).toBe('No section headed "nope".');
	});
});

describe("grep_vault with a note path as folder", () => {
	it("prefers an existing folder over a note of the same name", async () => {
		const vault = freshVault();
		vault.seed("Templates/Daily.md", "# Daily\n\n## Capture\n");
		vault.seed("Daily/2026-11-01.md", "## Capture\n\n> A quote\n");
		const { ctx } = makeCtx(vault);
		const out = await grepVault.execute({ pattern: "A quote", folder: "Daily" }, ctx);
		expect(out).toMatch(/^1 matching line in 1 note/);
		expect(out).toContain("Daily/2026-11-01.md:3");
	});

	it("searches just that note", async () => {
		const { ctx } = makeCtx(freshVault());
		const out = await grepVault.execute({ pattern: "sensors", folder: "Ideas/Sensors.md" }, ctx);
		expect(out).toMatch(/^1 matching line in 1 note/);
		expect(out).toContain("Ideas/Sensors.md:2");
	});
});
