import { describe, expect, it } from "vitest";
import { keywordSearch } from "../src/search";
import {
	appendToNote,
	createNote,
	editNote,
	getActiveNote,
	listNotes,
	normalizeNotePath,
	readNote,
	replaceNote,
	searchNotes,
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
		expect(() => normalizeNotePath(".obsidian/plugins/x")).toThrow();
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
	it("is a no-op when identical", async () => {
		const vault = freshVault();
		const { ctx, approvals } = makeCtx(vault);
		const out = await replaceNote.execute({ path: "Ideas/Sensors", content: await vault.read("Ideas/Sensors.md") }, ctx);
		expect(out).toMatch(/identical/);
		expect(approvals).toHaveLength(0);
	});
});
