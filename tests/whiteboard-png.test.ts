import { inflateSync } from "zlib";
import { describe, expect, it } from "vitest";
import { BOARD, DIGIT_STROKES, whiteboardInk, whiteboardPng, whiteboardSize } from "../scripts/whiteboard-png";

/** Share of the pixels in a rectangle of one digit's box (fractions of the box) that are ink. */
function inked(ink: boolean[][], digit: number, x0: number, x1: number, y0: number, y1: number): number {
	const left = BOARD.margin + digit * (BOARD.digitWidth + BOARD.gap);
	let on = 0;
	let all = 0;
	for (let y = Math.round(BOARD.margin + y0 * BOARD.digitHeight); y < Math.round(BOARD.margin + y1 * BOARD.digitHeight); y++) {
		for (let x = Math.round(left + x0 * BOARD.digitWidth); x < Math.round(left + x1 * BOARD.digitWidth); x++) {
			all++;
			if (ink[y][x]) on++;
		}
	}
	return on / all;
}

describe("the whiteboard picture of the read-image scenario", () => {
	it("is a valid PNG of the size it says, black on white", () => {
		const png = Buffer.from(whiteboardPng("47"));
		const { width, height } = whiteboardSize("47");
		expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		expect(png.readUInt32BE(16)).toBe(width);
		expect(png.readUInt32BE(20)).toBe(height);
		// One IDAT chunk follows the 25 bytes of signature and IHDR.
		const length = png.readUInt32BE(33);
		expect(png.subarray(37, 41).toString()).toBe("IDAT");
		const raw = inflateSync(png.subarray(41, 41 + length));
		expect(raw.length).toBe((width * 3 + 1) * height);
		const ink = whiteboardInk("47");
		const dark = ink.flat().filter(Boolean).length;
		let darkBytes = 0;
		for (const b of raw) if (b === 20) darkBytes++;
		expect(darkBytes).toBe(dark * 3);
		// Large and thick: the number fills a good part of the picture.
		expect(width).toBeGreaterThanOrEqual(500);
		expect(dark / (width * height)).toBeGreaterThan(0.1);
	});

	it("draws a 7 that is not a 1: a bar across the whole top, a slanted leg, no foot", () => {
		const ink = whiteboardInk("47");
		// The top bar runs the full width of the box.
		expect(inked(ink, 1, 0, 1, -0.04, 0.04)).toBeGreaterThan(0.95);
		// Below the bar the left third is empty all the way down, and so is the bottom right: no stem in the middle, no foot.
		expect(inked(ink, 1, 0, 0.2, 0.15, 1.05)).toBe(0);
		expect(inked(ink, 1, 0.7, 1, 0.8, 1.05)).toBe(0);
		// The leg ends at the bottom left of centre and starts at the top right.
		expect(inked(ink, 1, 0.3, 0.46, 0.9, 1)).toBeGreaterThan(0.9);
		expect(inked(ink, 1, 0.8, 0.95, 0.1, 0.2)).toBeGreaterThan(0.5);
	});

	it("draws a 4 with a crossbar through the stem, and a 1 that differs from the 7", () => {
		const ink = whiteboardInk("41");
		expect(inked(ink, 0, 0, 1, 0.66, 0.74)).toBeGreaterThan(0.95);
		expect(inked(ink, 0, 0.66, 0.78, 0, 1)).toBeGreaterThan(0.95);
		// The 1 has a foot and no top bar.
		expect(inked(ink, 1, 0.12, 0.98, 0.96, 1.04)).toBeGreaterThan(0.95);
		expect(inked(ink, 1, 0.75, 1, -0.04, 0.5)).toBe(0);
	});

	it("has strokes for every digit", () => {
		for (const d of "0123456789") expect(DIGIT_STROKES[d]?.length, d).toBeGreaterThan(0);
	});
});
