/**
 * Which editor "the cursor" is in when the user acts from the chat panel. Obsidian's "active
 * markdown view" is null there: the panel the user just clicked in is the active view, not the note
 * beside it. So "Insert at cursor", "Edit the selected text" and the selection the agent is told
 * about look for the note the user was last working in instead. Pure: no Obsidian imports.
 */

/** A markdown editor that is open, and the path of the note it shows. */
export interface EditorCandidate<T> {
	view: T;
	path: string | null;
}

export interface EditorSituation<T> {
	/** The markdown editor that has the focus, when one has. */
	focused: T | null;
	/** The tab the user most recently worked in outside the side panels, when it is a markdown editor. */
	recent: EditorCandidate<T> | null;
	/** Every markdown editor that is open and loaded. */
	open: EditorCandidate<T>[];
	/** The note Obsidian calls active (it stays the active file while a side panel has the focus). */
	activePath: string | null;
}

/**
 * The editor to act on, or null when no note can be meant.
 * 1. The editor with the focus.
 * 2. The editor the user was last in (the usual case from the chat: note on the left, chat on the right).
 * 3. An editor showing the active note (the last-used tab was something else, a canvas or a PDF).
 * 4. The only editor there is.
 * With several notes open and none of them last used or active, nothing is picked: text is never
 * put into a note the user did not point at.
 */
export function pickEditorTarget<T>(s: EditorSituation<T>): T | null {
	if (s.focused) return s.focused;
	if (s.recent) return s.recent.view;
	if (s.activePath !== null) {
		const showing = s.open.find((c) => c.path === s.activePath);
		if (showing) return showing.view;
	}
	return s.open.length === 1 ? s.open[0].view : null;
}
