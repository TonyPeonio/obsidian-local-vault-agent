import { describe, expect, it } from "vitest";
import { Agent, newConversation, type AgentConfig } from "../src/agent";
import { keywordSearch } from "../src/search";
import { ALL_TOOLS, editNote, editNotes, replaceNote } from "../src/tools";
import type { ApprovalRequest, ToolContext } from "../src/types";
import { UndoStack } from "../src/undo";
import { FakeOllama, FakeVault } from "./fakes";

function ctx(vault: FakeVault, approve: (r: ApprovalRequest) => Promise<"approve" | "reject">, signal?: AbortSignal): ToolContext & { records: unknown[] } {
	const records: unknown[] = [];
	return { vault, search: async () => [], approve, maxResultChars: 4000, signal, recordChange: (c) => records.push(c), records };
}

/** A vault whose writes fail for one path, like a file locked by another program. */
class FailingVault extends FakeVault {
	constructor(
		initial: Record<string, string>,
		private failing: string,
	) {
		super(initial);
	}
	async modify(path: string, content: string): Promise<void> {
		if (path === this.failing) throw new Error("EBUSY: resource busy or locked");
		return super.modify(path, content);
	}
}

describe("writes are whole or nothing", () => {
	it("writes nothing when Stop was pressed while the diff was open", async () => {
		const vault = new FakeVault({ "A.md": "one two" });
		const abort = new AbortController();
		const c = ctx(vault, async () => {
			abort.abort();
			return "approve";
		}, abort.signal);
		await expect(editNote.execute({ path: "A", old_text: "two", new_text: "three" }, c)).rejects.toThrow(/Stopped before writing/);
		expect(await vault.read("A.md")).toBe("one two");
		expect(c.records).toEqual([]);
	});

	it("writes nothing when the note changed while the diff was open", async () => {
		const vault = new FakeVault({ "A.md": "one two" });
		const c = ctx(vault, async () => {
			await vault.modify("A.md", "one two, and the user typed this");
			return "approve";
		});
		await expect(replaceNote.execute({ path: "A", content: "rewritten" }, c)).rejects.toThrow(/changed while the change was waiting/);
		expect(await vault.read("A.md")).toBe("one two, and the user typed this");
	});

	it("records nothing for a write that failed, and leaves the note as it was", async () => {
		const vault = new FailingVault({ "A.md": "one two" }, "A.md");
		const c = ctx(vault, async () => "approve");
		await expect(editNote.execute({ path: "A", old_text: "two", new_text: "three" }, c)).rejects.toThrow(/EBUSY/);
		expect(await vault.read("A.md")).toBe("one two");
		expect(c.records).toEqual([]);
	});

	it("edit_notes: a failed note is reported and unchanged, the others are written and recorded", async () => {
		const vault = new FailingVault({ "A.md": "alpha", "B.md": "beta", "C.md": "gamma" }, "B.md");
		const c = ctx(vault, async () => "approve");
		const out = await editNotes.execute(
			{
				edits: [
					{ path: "A", old_text: "alpha", new_text: "ALPHA" },
					{ path: "B", old_text: "beta", new_text: "BETA" },
					{ path: "C", old_text: "gamma", new_text: "GAMMA" },
				],
			},
			c,
		);
		expect(out).toContain("B.md: the write failed (EBUSY");
		expect([await vault.read("A.md"), await vault.read("B.md"), await vault.read("C.md")]).toEqual(["ALPHA", "beta", "GAMMA"]);
		expect(c.records).toHaveLength(2);
	});
});

const config: AgentConfig = { model: "fake", numCtx: 8192, temperature: 0, keepAlive: "1m", maxIterations: 6, maxToolResultChars: 4000, autoApprove: false, autoContinue: false, extraSystemPrompt: "", citations: "off" };

describe("a turn that fails or is stopped", () => {
	it("keeps every applied change complete and recorded, so the whole turn can be undone", async () => {
		const vault = new FakeVault({ "A.md": "alpha", "B.md": "beta" });
		const undo = new UndoStack();
		const ollama = new FakeOllama([
			{ tool: "edit_note", args: { path: "A", old_text: "alpha", new_text: "ALPHA" } },
			{ tool: "edit_note", args: { path: "B", old_text: "beta", new_text: "BETA" } },
			{ error: new Error("connection reset") },
		]);
		const agent = new Agent({ client: ollama.asClient(), vault, tools: ALL_TOOLS, search: (q, l) => keywordSearch(vault, q, l), approve: async () => "approve", getConfig: () => config, undo });
		const conv = newConversation();
		await expect(agent.run(conv, "uppercase both", {})).rejects.toThrow(/connection reset/);
		expect([await vault.read("A.md"), await vault.read("B.md")]).toEqual(["ALPHA", "BETA"]);
		expect(undo.forTurn(0, conv.id).map((c) => [c.path, c.before, c.after])).toEqual([
			["B.md", "beta", "BETA"],
			["A.md", "alpha", "ALPHA"],
		]);
	});

	it("stopping during an approval writes nothing for that change", async () => {
		const vault = new FakeVault({ "A.md": "alpha" });
		const abort = new AbortController();
		const ollama = new FakeOllama([{ tool: "edit_note", args: { path: "A", old_text: "alpha", new_text: "ALPHA" } }, { content: "done" }]);
		const agent = new Agent({
			client: ollama.asClient(),
			vault,
			tools: ALL_TOOLS,
			search: (q, l) => keywordSearch(vault, q, l),
			approve: async () => {
				abort.abort();
				return "approve";
			},
			getConfig: () => config,
			undo: new UndoStack(),
		});
		await agent.run(newConversation(), "uppercase", {}, abort.signal).catch(() => undefined);
		expect(await vault.read("A.md")).toBe("alpha");
	});
});
