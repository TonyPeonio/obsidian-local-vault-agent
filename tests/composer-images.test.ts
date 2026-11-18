import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, attachmentName, checkImage, withImages } from "../src/composer-images";
import { attachMentions } from "../src/mentions";
import LocalVaultAgentPlugin from "../src/main";
import { FakeVault } from "./fakes";

describe("checkImage", () => {
	it("accepts PNG, JPEG and WebP by type, whatever the name", () => {
		expect(checkImage({ name: "image.png", type: "image/png", size: 10 })).toEqual({ ok: true, extension: "png" });
		expect(checkImage({ name: "IMG_0042.JPG", type: "image/jpeg", size: 10 })).toEqual({ ok: true, extension: "jpg" });
		expect(checkImage({ name: "", type: "image/webp", size: 10 })).toEqual({ ok: true, extension: "webp" });
	});

	it("goes by the extension when the drag gives no type", () => {
		expect(checkImage({ name: "scan.jpeg", type: "", size: 10 })).toEqual({ ok: true, extension: "jpeg" });
		expect(checkImage({ name: "notes.md", type: "", size: 10 })).toEqual({ ok: false, reason: "not-image" });
	});

	it("refuses pictures the vision model cannot be sent, and says they are pictures", () => {
		expect(checkImage({ name: "anim.gif", type: "image/gif", size: 10 })).toEqual({ ok: false, reason: "unsupported" });
		expect(checkImage({ name: "photo.heic", type: "", size: 10 })).toEqual({ ok: false, reason: "unsupported" });
		expect(checkImage({ name: "drawing.svg", type: "image/svg+xml", size: 10 })).toEqual({ ok: false, reason: "unsupported" });
	});

	it("refuses other files, empty files and very large ones", () => {
		expect(checkImage({ name: "report.pdf", type: "application/pdf", size: 10 })).toEqual({ ok: false, reason: "not-image" });
		// A text file that happens to be called .png is not taken for a picture when the type says otherwise.
		expect(checkImage({ name: "fake.png", type: "text/plain", size: 10 })).toEqual({ ok: false, reason: "not-image" });
		expect(checkImage({ name: "a.png", type: "image/png", size: 0 })).toEqual({ ok: false, reason: "empty" });
		expect(checkImage({ name: "a.png", type: "image/png", size: MAX_IMAGE_BYTES + 1 })).toEqual({ ok: false, reason: "too-large" });
		expect(checkImage({ name: "a.png", type: "image/png", size: MAX_IMAGE_BYTES })).toEqual({ ok: true, extension: "png" });
	});
});

describe("attachmentName", () => {
	const now = new Date(2026, 10, 17, 18, 55, 1);

	it("names a clipboard picture the way Obsidian does", () => {
		expect(attachmentName({ name: "image.png", type: "image/png", size: 1 }, "png", now)).toBe("Pasted image 20261117185501.png");
		expect(attachmentName({ name: "", type: "image/jpeg", size: 1 }, "jpg", now)).toBe("Pasted image 20261117185501.jpg");
	});

	it("keeps a dropped file's own name, with the extension that was checked", () => {
		expect(attachmentName({ name: "Whiteboard after meeting.PNG", type: "image/png", size: 1 }, "png", now)).toBe("Whiteboard after meeting.png");
	});

	it("drops characters a vault path or a wikilink cannot hold", () => {
		expect(attachmentName({ name: "a/b\\c: [draft] #1 ^x|y?.jpeg", type: "image/jpeg", size: 1 }, "jpg", now)).toBe("a b c draft 1 x y.jpg");
		expect(attachmentName({ name: "..hidden..png", type: "image/png", size: 1 }, "png", now)).toBe("hidden.png");
		expect(attachmentName({ name: "???.png", type: "image/png", size: 1 }, "png", now)).toBe("Pasted image 20261117185501.png");
	});
});

describe("withImages", () => {
	it("leaves a message without pictures as it is", () => {
		expect(withImages("Hello", [], 1000)).toBe("Hello");
	});

	it("appends what was read, under an opening the chat hides like attached notes", () => {
		const message = withImages("What number is on the board?", [{ path: "Attachments/Pasted image 1.png", text: "Text: 47\nDescription: a whiteboard." }], 1000);
		// The chat shows only what is before this marker, live and when a chat is restored.
		expect(message.split("\n\n(The user attached")[0]).toBe("What number is on the board?");
		expect(message).toContain("--- Attached image: Attachments/Pasted image 1.png ---\nText: 47\nDescription: a whiteboard.");
		expect(message).toContain("already read with read_image");
		expect(message).toMatch(/\(The user attached the following image to this message\. It was saved/);
	});

	it("speaks of several pictures in the plural and keeps their order", () => {
		const message = withImages("Compare.", [{ path: "a.png", text: "A" }, { path: "b.png", text: "B" }], 1000);
		expect(message).toMatch(/the following images to this message\. They were saved in the vault at the paths given/);
		expect(message.indexOf("--- Attached image: a.png ---")).toBeLessThan(message.indexOf("--- Attached image: b.png ---"));
	});

	it("tells the model when a picture could not be read, instead of leaving it out", () => {
		const message = withImages("What is this?", [{ path: "a.png", error: "qwen3.5:9b cannot read images" }], 1000);
		expect(message).toContain("--- Attached image: a.png ---\n(It could not be read: qwen3.5:9b cannot read images. Say so; do not guess what it shows.)");
	});

	it("cuts a very long reading and says how to get the rest", () => {
		const message = withImages("?", [{ path: "a.png", text: "x".repeat(5000) }], 200);
		expect(message).toContain(`${"x".repeat(200)}\n[… truncated; call read_image with a question for the rest]`);
		expect(message).not.toContain("x".repeat(201));
	});

	it("comes after attached notes, and the chat still shows only the user's words", async () => {
		const vault = new FakeVault({ "Ideas/Plan.md": "# Plan\nThree steps." });
		const { message: noted } = await attachMentions("Does [[Plan]] match this photo?", vault, 4000);
		const message = withImages(noted, [{ path: "photo.jpg", text: "Text: step 1" }], 1000);
		expect(message.split("\n\n(The user attached")[0]).toBe("Does [[Plan]] match this photo?");
		expect(message.indexOf("--- Attached note: Ideas/Plan.md ---")).toBeLessThan(message.indexOf("--- Attached image: photo.jpg ---"));
	});
});

/** The parts of Obsidian that saveAttachment uses, recording what was created. */
function fakeApp(opts: { folderExists: boolean; available: string; activeFile?: string }) {
	const created: { path: string; bytes: number }[] = [];
	const folders: string[] = [];
	const asked: { name: string; source: string }[] = [];
	const existing = new Set<string>();
	const app = {
		workspace: { getActiveFile: () => (opts.activeFile ? { path: opts.activeFile } : null) },
		fileManager: {
			getAvailablePathForAttachment: async (name: string, source: string) => {
				asked.push({ name, source });
				return opts.available;
			},
		},
		vault: {
			getFolderByPath: (p: string) => (opts.folderExists || folders.includes(p) ? { path: p } : null),
			createFolder: async (p: string) => void folders.push(p),
			createBinary: async (path: string, data: ArrayBuffer) => {
				if (existing.has(path)) throw new Error("File already exists.");
				existing.add(path);
				created.push({ path, bytes: data.byteLength });
				return { path };
			},
		},
	};
	return { app, created, folders, asked, existing };
}
const save = (app: unknown, name: string, data: ArrayBuffer) => LocalVaultAgentPlugin.prototype.saveAttachment.call({ app, settings: { excludedFolders: [] } } as unknown as LocalVaultAgentPlugin, name, data);

describe("saving a pasted picture", () => {
	it("saves at the path Obsidian gives for an attachment of the open note", async () => {
		const f = fakeApp({ folderExists: true, available: "Attachments/Pasted image 20261117185501.png", activeFile: "Projects/Robot.md" });
		const path = await save(f.app, "Pasted image 20261117185501.png", new ArrayBuffer(12));
		expect(path).toBe("Attachments/Pasted image 20261117185501.png");
		expect(f.asked).toEqual([{ name: "Pasted image 20261117185501.png", source: "Projects/Robot.md" }]);
		expect(f.created).toEqual([{ path: "Attachments/Pasted image 20261117185501.png", bytes: 12 }]);
		expect(f.folders).toEqual([]);
	});

	it("creates the attachment folder when it does not exist yet", async () => {
		const f = fakeApp({ folderExists: false, available: "Files/Images/board.png" });
		await save(f.app, "board.png", new ArrayBuffer(3));
		expect(f.folders).toEqual(["Files/Images"]);
		expect(f.asked[0].source).toBe("");
	});

	it("saves into the vault root without creating a folder", async () => {
		const f = fakeApp({ folderExists: false, available: "board.png" });
		expect(await save(f.app, "board.png", new ArrayBuffer(3))).toBe("board.png");
		expect(f.folders).toEqual([]);
	});

	it("never writes over a file: a path that is taken fails instead", async () => {
		const f = fakeApp({ folderExists: true, available: "Attachments/board.png" });
		f.existing.add("Attachments/board.png");
		await expect(save(f.app, "board.png", new ArrayBuffer(3))).rejects.toThrow(/already exists/);
		expect(f.created).toEqual([]);
	});
});
