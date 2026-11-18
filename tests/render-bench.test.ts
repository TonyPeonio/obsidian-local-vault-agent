import { describe, expect, it } from "vitest";
import { replay, sampleAnswer, standInRender } from "../scripts/bench-render";

/**
 * The render benchmark's counts are deterministic, so they are checked here: a regression in how
 * much text is handed to the markdown renderer while a reply streams fails a test, not only a
 * number in a report. (Timings are left to `npm run bench:render`.)
 */
describe("drawing a streamed reply", () => {
	it("hands the renderer a fraction of the characters the old every-120-ms redraw did", async () => {
		const text = sampleAnswer(1000);
		const before = await replay(text, 40, "before");
		const after = await replay(text, 40, "after");
		expect(before.screenMatches).toBe(true);
		expect(after.screenMatches).toBe(true);
		// 430,548 characters before and 53,835 after when this was written.
		expect(after.chars).toBeLessThan(before.chars / 6);
	});

	it("grows with the length of the reply, not with its square", async () => {
		const short = await replay(sampleAnswer(1000), 40, "after");
		const long = await replay(sampleAnswer(4000), 40, "after");
		const lengths = sampleAnswer(4000).length / sampleAnswer(1000).length;
		expect(long.chars / short.chars).toBeLessThan(lengths * 1.3);
		// The old policy: four times the text was about sixteen times the work.
		const oldShort = await replay(sampleAnswer(1000), 40, "before");
		const oldLong = await replay(sampleAnswer(4000), 40, "before");
		expect(oldLong.chars / oldShort.chars).toBeGreaterThan(lengths * 3);
	});

	it("renders rarely when a render is slow, and still ends with the whole reply", async () => {
		const text = sampleAnswer(4000);
		// A renderer charged 500 µs per character: a 4,000-character block takes two seconds.
		const slow = await replay(text, 40, "after", 500);
		const fast = await replay(text, 40, "after", 5);
		expect(slow.renders).toBeLessThan(fast.renders / 2);
		expect(slow.screenMatches).toBe(true);
	});

	it("uses a stand-in renderer that keeps every block of the sample", () => {
		const tags = standInRender(sampleAnswer(300)).map((n) => /^<(\w+)/.exec(n.html)?.[1]);
		expect(tags).toEqual(["h2", "p", "ul", "pre", "p", "table"]);
	});
});
