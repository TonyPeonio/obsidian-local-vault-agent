import { describe, expect, it } from "vitest";
import { MessageQueue, queuePreview, restoredDraft } from "../src/message-queue";

describe("MessageQueue", () => {
	it("sends in the order the messages were queued", () => {
		const q = new MessageQueue();
		q.add("first");
		q.add("second", false);
		q.add("third", true, ["Attachments/pic.png"]);
		expect(q.size).toBe(3);
		expect(q.next()).toMatchObject({ text: "first", attach: true, images: [] });
		expect(q.next()).toMatchObject({ text: "second", attach: false });
		expect(q.next()).toMatchObject({ text: "third", images: ["Attachments/pic.png"] });
		expect(q.next()).toBeNull();
		expect(q.size).toBe(0);
	});

	it("keeps the order when a message that could not be sent is put back", () => {
		const q = new MessageQueue();
		q.add("first");
		q.add("second");
		const item = q.next()!;
		q.putBack(item);
		expect(q.list.map((m) => m.text)).toEqual(["first", "second"]);
	});

	it("takes one message out by its id and leaves the rest", () => {
		const q = new MessageQueue();
		q.add("a");
		const b = q.add("b");
		q.add("c");
		expect(q.remove(b.id)?.text).toBe("b");
		expect(q.remove(b.id)).toBeNull();
		expect(q.list.map((m) => m.text)).toEqual(["a", "c"]);
	});

	it("gives every message its own id, also after the queue was emptied", () => {
		const q = new MessageQueue();
		const a = q.add("a");
		q.clear();
		const b = q.add("b");
		expect(b.id).not.toBe(a.id);
	});

	it("hands everything back on clear, in order, and is empty afterwards", () => {
		const q = new MessageQueue();
		q.add("a");
		q.add("b");
		expect(q.clear().map((m) => m.text)).toEqual(["a", "b"]);
		expect(q.size).toBe(0);
		expect(q.clear()).toEqual([]);
	});
});

describe("restoredDraft and queuePreview", () => {
	it("puts returned messages before what was being typed, one per paragraph", () => {
		const q = new MessageQueue();
		q.add("Summarise [[Plan]]");
		q.add("  and list the open questions  ");
		expect(restoredDraft(q.clear(), " then ")).toBe("Summarise [[Plan]]\n\nand list the open questions\n\nthen");
	});

	it("leaves the message box as it is when nothing was queued", () => {
		expect(restoredDraft([], "half a sentence")).toBe("half a sentence");
		expect(restoredDraft([], "")).toBe("");
	});

	it("shows a queued message on one line, cut when long", () => {
		expect(queuePreview("two\nlines\n\n  here")).toBe("two lines here");
		const long = queuePreview("word ".repeat(100), 40);
		expect(long.length).toBeLessThanOrEqual(40);
		expect(long.endsWith("…")).toBe(true);
	});
});
