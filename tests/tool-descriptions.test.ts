import { describe, expect, it } from "vitest";
import { LECTURE_TOOLS } from "../src/lecture-companion";
import { ALL_TOOLS } from "../src/tools";
import type { ToolDefinition } from "../src/types";
import { readImage } from "../src/vision";

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
});
