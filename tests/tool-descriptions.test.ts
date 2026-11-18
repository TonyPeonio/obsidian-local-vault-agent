import { describe, expect, it } from "vitest";
import { IMAGE_EXTENSIONS, imageEmbeds } from "../src/embeds";
import { LECTURE_TOOLS } from "../src/lecture-companion";
import { ALL_TOOLS, listFiles, readNote } from "../src/tools";
import type { ToolContext, ToolDefinition } from "../src/types";
import { readImage } from "../src/vision";
import { FakeVault } from "./fakes";

/** Every tool the model can be given: the core set, the Lecture Companion pair and read_image. */
const TOOLS: ToolDefinition[] = [...ALL_TOOLS, ...LECTURE_TOOLS, readImage];

/** Characters of description text in a tool: its own and each parameter's. */
function descriptionChars(tool: ToolDefinition): number {
	let n = tool.description.length;
	const walk = (o: unknown) => {
		if (!o || typeof o !== "object") return;
		for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
			if (k === "description" && typeof v === "string") n += v.length;
			else walk(v);
		}
	};
	walk(tool.parameters);
	return n;
}

describe("tool descriptions", () => {
	it("do not grow: they are sent to the model with every call", () => {
		// 10,732 characters at 0.8.0. A new parameter or sentence has to be paid for by cutting words elsewhere.
		const total = TOOLS.reduce((n, t) => n + descriptionChars(t), 0);
		expect(total).toBeLessThanOrEqual(10732);
	});

	it("list_files no longer says attachments cannot be read: read_file reads them", () => {
		expect(listFiles.description).not.toMatch(/cannot be read/);
		expect(listFiles.description).toContain("read_file reads a PDF or text file");
	});

	it("read_note promises what its header has: tags, links and backlinks, no headings", async () => {
		expect(readNote.description).toContain("with its tags, links and backlinks.");
		const vault = new FakeVault({ "A.md": "#t\n# Title\n\n## Section\n\nSee [[B]].", "B.md": "Back to [[A]]." });
		const out = await readNote.execute({ path: "A" }, { vault, search: async () => [], approve: async () => "approve", maxResultChars: 12000 });
		expect(out.slice(0, out.indexOf("\n---\n"))).toBe("# A.md\ntags: #t\nlinks to: B\nlinked from: B.md\nlength: 34 characters");
	});

	it("read_note names only the embedded images read_image can read", async () => {
		const vault = new FakeVault({ "A.md": "![[board.png]] ![[anim.gif]] ![[logo.svg]] ![[old.bmp]] ![[photo.JPEG]] ![[scan.webp]]", "G.md": "![[anim.gif]] ![[logo.svg]]" });
		const ctx: ToolContext = { vault, search: async () => [], approve: async () => "approve", maxResultChars: 12000, describeImage: async () => "" };
		expect(await readNote.execute({ path: "A" }, ctx)).toContain("[This note embeds 3 images (board.png, photo.JPEG, scan.webp). Its text cannot see them; if what they show matters, read one with read_image.]");
		expect(await readNote.execute({ path: "G" }, ctx)).not.toContain("read_image");
		// Every type the note names is one the reader accepts.
		expect(imageEmbeds("![[a.png]] ![[b.jpg]] ![[c.jpeg]] ![[d.webp]] ![[e.gif]] ![[f.bmp]] ![[g.svg]]").map((p) => p.split(".").pop())).toEqual(IMAGE_EXTENSIONS);
	});
});
