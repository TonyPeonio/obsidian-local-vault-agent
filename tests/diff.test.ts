import { describe, expect, it } from "vitest";
import { applyTextEdit, computeDiff } from "../src/diff";

describe("computeDiff", () => {
	it("counts added and removed lines", () => {
		const d = computeDiff("a\nb\nc\n", "a\nB\nc\nd\n");
		expect(d.added).toBe(2);
		expect(d.removed).toBe(1);
	});

	it("collapses long unchanged runs", () => {
		const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const after = before.replace("line 20", "LINE 20");
		const d = computeDiff(before, after, 2);
		const collapsed = d.lines.filter((l) => l.text.includes("unchanged line"));
		expect(collapsed).toHaveLength(2);
		expect(d.lines.some((l) => l.type === "remove" && l.text === "line 20")).toBe(true);
	});

	it("handles a new file", () => {
		const d = computeDiff("", "hello\nworld\n");
		expect(d.added).toBe(2);
		expect(d.removed).toBe(0);
	});
});

describe("applyTextEdit", () => {
	it("replaces a unique match", () => {
		const r = applyTextEdit("foo bar baz", "bar", "qux");
		expect(r).toEqual({ ok: true, content: "foo qux baz", count: 1 });
	});

	it("refuses an ambiguous match unless replace_all", () => {
		const r = applyTextEdit("a b a", "a", "c");
		expect(r.ok).toBe(false);
		const all = applyTextEdit("a b a", "a", "c", true);
		expect(all).toEqual({ ok: true, content: "c b c", count: 2 });
	});

	it("reports a missing match", () => {
		const r = applyTextEdit("hello", "nope", "x");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/not found/);
	});

	it("tolerates trailing whitespace differences", () => {
		const content = "- item one   \n- item two\n";
		const r = applyTextEdit(content, "- item one\n- item two", "- merged");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.content).toBe("- merged\n");
	});

	it("does not treat $ in replacements specially", () => {
		const r = applyTextEdit("price: X", "X", "$100 & more $&");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.content).toBe("price: $100 & more $&");
	});
});
