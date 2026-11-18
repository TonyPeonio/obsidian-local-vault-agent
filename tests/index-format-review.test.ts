import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/chunker";
import { SemanticIndex, type IndexData } from "../src/index";
import { FakeOllama, FakeVault } from "./fakes";

// Written in review: an index entry in the shape the released 0.8.0 wrote it (src/index.ts at
// 50da665: `{ mtime, chunks: [{ heading, text, vec }] }`, no `fmt`, no `rest`, no `crumb`).

class MemoryStore {
	data: IndexData | null = null;
	async load() {
		return this.data;
	}
	async save(d: IndexData) {
		this.data = JSON.parse(JSON.stringify(d));
	}
}

const NOTE = "# Robot\n\nA chess robot with a gantry.\n\n## Wiring\n\nHall sensors under every square.\n\n### Power\n\nA 12 V supply feeds the steppers.\n";

describe("review: an index entry as 0.8.0 wrote it", () => {
	it("is read, cut again on the first sync, and embeds again exactly the pieces whose heading path is not their nearest heading", async () => {
		const vault = new FakeVault({ "Projects/Robot.md": NOTE });
		const store = new MemoryStore();
		const opts = { getModel: () => "nomic-embed-text", isEnabled: () => true, shouldIndex: () => true, batchSize: 16 };
		const first = new SemanticIndex(new FakeOllama([]).asClient(), vault, store, opts);
		await first.syncAll();
		await first.flush();
		const entry = store.data!.files["Projects/Robot.md"] as unknown as Record<string, unknown>;
		const vectors = (entry.chunks as { heading: string; text: string; vec: string }[]).map((c) => c.vec);
		delete entry.fmt;
		delete entry.rest;
		entry.chunks = (entry.chunks as { heading: string; text: string; vec: string }[]).map((c) => ({ heading: c.heading, text: c.text, vec: c.vec }));

		const ollama = new FakeOllama([]);
		const index = new SemanticIndex(ollama.asClient(), vault, store, opts);
		await index.load();
		// Before the sync the old entry is searchable as it is.
		expect(index.status().indexedFiles).toBe(1);
		await index.syncAll();
		await index.flush();

		const cut = chunkMarkdown(NOTE);
		const pathDiffers = cut.filter((c) => c.crumb !== c.heading);
		// This note has both kinds of piece, or the test says nothing.
		expect(pathDiffers.length).toBeGreaterThan(0);
		expect(pathDiffers.length).toBeLessThan(cut.length);
		expect(ollama.embedCalls.flat()).toHaveLength(pathDiffers.length);
		const after = store.data!.files["Projects/Robot.md"];
		expect(after.fmt).toBe(2);
		expect(after.rest).toBeDefined();
		expect(after.chunks.map((c) => c.text)).toEqual(cut.map((c) => c.text));
		// (A piece whose heading path is its nearest heading was embedded from the same text by 0.8.0, so its vector is kept: it is not among the embed calls counted above.)
		expect(after.chunks).toHaveLength(vectors.length);
		// A second sync has nothing to do.
		await index.syncAll();
		expect(ollama.embedCalls.flat()).toHaveLength(pathDiffers.length);
	});
});
