import { describe, expect, it } from "vitest";
import { pickEditorTarget, type EditorCandidate } from "../src/editor-target";

const ed = (name: string): EditorCandidate<string> => ({ view: `editor:${name}`, path: `${name}.md` });

describe("which editor the chat's 'Insert at cursor' means", () => {
	it("is the note the user was last in when the chat panel has the focus", () => {
		// The normal case, and the one that used to fail: clicking the button in the chat makes the
		// chat the active view, so there is no focused editor.
		const a = ed("A");
		const b = ed("B");
		expect(pickEditorTarget({ focused: null, recent: b, open: [a, b], activePath: "B.md" })).toBe("editor:B");
	});

	it("is the focused editor when there is one (the command palette, a hotkey)", () => {
		const a = ed("A");
		const b = ed("B");
		expect(pickEditorTarget({ focused: "editor:A", recent: b, open: [a, b], activePath: "B.md" })).toBe("editor:A");
	});

	it("picks the pane last used when the same note is open in two panes", () => {
		const left = { view: "left", path: "A.md" };
		const right = { view: "right", path: "A.md" };
		expect(pickEditorTarget({ focused: null, recent: right, open: [left, right], activePath: "A.md" })).toBe("right");
	});

	it("falls back to an editor showing the active note when the last-used tab is not a note", () => {
		// Last-used tab is a canvas or a PDF: `recent` is null.
		const a = ed("A");
		const b = ed("B");
		expect(pickEditorTarget({ focused: null, recent: null, open: [a, b], activePath: "A.md" })).toBe("editor:A");
	});

	it("uses the only open note when nothing else says which", () => {
		expect(pickEditorTarget({ focused: null, recent: null, open: [ed("A")], activePath: null })).toBe("editor:A");
		expect(pickEditorTarget({ focused: null, recent: null, open: [ed("A")], activePath: "Gone.md" })).toBe("editor:A");
	});

	it("picks nothing rather than guess between several notes, or when no note is open", () => {
		expect(pickEditorTarget({ focused: null, recent: null, open: [ed("A"), ed("B")], activePath: null })).toBeNull();
		expect(pickEditorTarget({ focused: null, recent: null, open: [ed("A"), ed("B")], activePath: "C.md" })).toBeNull();
		expect(pickEditorTarget({ focused: null, recent: null, open: [], activePath: "A.md" })).toBeNull();
		expect(pickEditorTarget<string>({ focused: null, recent: null, open: [], activePath: null })).toBeNull();
	});
});
