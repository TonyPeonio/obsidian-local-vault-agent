import { diffLines } from "diff";

export interface DiffLine {
	type: "add" | "remove" | "same";
	text: string;
}

export interface DiffSummary {
	lines: DiffLine[];
	added: number;
	removed: number;
}

/** Line diff with unchanged context collapsed to `context` lines around each change. */
export function computeDiff(before: string, after: string, context = 3): DiffSummary {
	const parts = diffLines(before, after);
	const all: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	for (const part of parts) {
		const lines = part.value.replace(/\n$/, "").split("\n");
		if (part.value === "") continue;
		for (const text of lines) {
			if (part.added) {
				all.push({ type: "add", text });
				added++;
			} else if (part.removed) {
				all.push({ type: "remove", text });
				removed++;
			} else {
				all.push({ type: "same", text });
			}
		}
	}

	// Collapse long runs of unchanged lines.
	const keep = new Array<boolean>(all.length).fill(false);
	all.forEach((l, i) => {
		if (l.type !== "same") {
			for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) {
				keep[j] = true;
			}
		}
	});
	const lines: DiffLine[] = [];
	let skipping = 0;
	all.forEach((l, i) => {
		if (keep[i]) {
			if (skipping > 0) {
				lines.push({ type: "same", text: `… ${skipping} unchanged line${skipping === 1 ? "" : "s"} …` });
				skipping = 0;
			}
			lines.push(l);
		} else {
			skipping++;
		}
	});
	if (skipping > 0) {
		lines.push({ type: "same", text: `… ${skipping} unchanged line${skipping === 1 ? "" : "s"} …` });
	}
	return { lines, added, removed };
}

/**
 * Replace `oldText` in `content`. Returns the new content, or an error string explaining
 * why the edit is ambiguous or impossible. Tries an exact match first, then a
 * whitespace-tolerant match so small indentation differences from the model don't fail.
 */
export function applyTextEdit(
	content: string,
	oldText: string,
	newText: string,
	replaceAll = false,
): { ok: true; content: string; count: number } | { ok: false; error: string } {
	if (!oldText) return { ok: false, error: "old_text must not be empty" };

	let count = countOccurrences(content, oldText);
	let needle = oldText;
	if (count === 0) {
		const relaxed = findRelaxed(content, oldText);
		if (relaxed) {
			needle = relaxed;
			count = countOccurrences(content, needle);
		}
	}
	if (count === 0) {
		return {
			ok: false,
			error:
				"old_text was not found in the note. Read the note again and copy the exact text you want to replace.",
		};
	}
	if (count > 1 && !replaceAll) {
		return {
			ok: false,
			error: `old_text occurs ${count} times. Include more surrounding context so it is unique, or set replace_all to true.`,
		};
	}
	const out = replaceAll ? content.split(needle).join(newText) : content.replace(needle, () => newText);
	return { ok: true, content: out, count: replaceAll ? count : 1 };
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let idx = 0;
	while ((idx = haystack.indexOf(needle, idx)) >= 0) {
		count++;
		idx += needle.length;
	}
	return count;
}

/** Find a region of `content` equal to `oldText` modulo trailing whitespace per line. */
function findRelaxed(content: string, oldText: string): string | null {
	const wanted = oldText.split("\n").map((l) => l.trimEnd());
	const lines = content.split("\n");
	for (let i = 0; i + wanted.length <= lines.length; i++) {
		let match = true;
		for (let j = 0; j < wanted.length; j++) {
			if (lines[i + j].trimEnd() !== wanted[j]) {
				match = false;
				break;
			}
		}
		if (match) return lines.slice(i, i + wanted.length).join("\n");
	}
	return null;
}
