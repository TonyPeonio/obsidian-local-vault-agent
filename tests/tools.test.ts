import { describe, expect, it } from "vitest";
import { keywordSearch } from "../src/search";
import {
	appendToNote,
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
	looksLikeRegex,
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

function makeCtx(vault: FakeVault, decision: ApprovalDecision = "approve") {
	const approvals: ApprovalRequest[] = [];
	const ctx: ToolContext = {
		vault,
		search: (q, limit) => keywordSearch(vault, q, limit),
		approve: async (req) => {
			approvals.push(req);
			return decision;
		},
		maxResultChars: 200,
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
	it("returns JSON hits", async () => {
		const { ctx } = makeCtx(freshVault());
		const out = await searchNotes.execute({ query: "hall sensors" }, ctx);
		const hits = JSON.parse(out);
		expect(hits[0].path).toBe("Ideas/Sensors.md");
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
		const { ctx } = makeCtx(vault);
		const first = await readNote.execute({ path: "Long.md" }, ctx);
		expect(first).toContain("TRUNCATED at character 200");
		const second = await readNote.execute({ path: "Long.md", offset: 400 }, ctx);
		expect(second).toContain("continuing from character 400");
		expect(second).not.toContain("TRUNCATED");
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
	it("falls back to keyword snippets without an index", async () => {
		const { ctx } = makeCtx(freshVault());
		const out = await searchPassages.execute({ query: "hall sensors" }, ctx);
		expect(out).toMatch(/semantic index is not available/);
		expect(out).toContain("Ideas/Sensors.md");
		expect(await searchPassages.execute({ query: "zzzz" }, ctx)).toMatch(/No passages matched/);
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
		const { ctx } = makeCtx(vault);
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
	});

	it("treats a containing text that is just the heading as the heading, and surveys", async () => {
		const vault = freshVault();
		vault.seed("Daily/2026-11-01.md", "# D\n\n## Capture\n\n- one\n- two\n");
		vault.seed("Daily/2026-11-02.md", "# D\n\n## Capture\n");
		const { ctx } = makeCtx(vault);
		const out = await listSections.execute({ containing: ["## Capture"], heading: "Capture", folder: "Daily/" }, ctx);
		expect(out).toMatch(/^2 sections \(non-empty lines/);
		expect(out).toContain("## Capture (2 lines");
		expect(out).toContain("(empty)");
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
		expect(out).toContain("S/L.md\n  ## a: ![[Recording yes, ### Summary yes → all\n  ## b: ![[Recording yes, ### Summary no");
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
		expect(out).toMatch(/^3 sections \(non-empty lines, characters, first line\):/);
		expect(out).toContain("Daily/a.md\n  ## Capture (3 lines, 40 chars): Fellowships from the talk:");
		expect(out).toContain("Daily/b.md\n  ## Capture (empty)");
		expect(out).toContain("Daily/c.md\n  ## Captured thoughts (1 line, 11 chars): > one quote");
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
