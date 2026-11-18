/**
 * The picture the read-image scenario shows the vision model: a number in black marker strokes
 * on a white board. Drawn here rather than kept as a file, so the benchmark needs no binary.
 *
 * The digits are strokes of a round marker in the shapes print uses, large and thick. Until
 * 0.9.0 they were 5×7 bitmap digits scaled up, whose 7 was a one-cell bar on a staircase; every
 * model read "47" as 41 or 42 in every run since 0.7.0, which measured the drawing, not the model.
 */
import { deflateSync } from "zlib";

type Point = [number, number];

/** Points of an ellipse as a closed stroke. */
function ellipse(cx: number, cy: number, rx: number, ry: number): Point[] {
	const points: Point[] = [];
	for (let k = 0; k <= 24; k++) points.push([cx + rx * Math.cos((k / 24) * 2 * Math.PI), cy + ry * Math.sin((k / 24) * 2 * Math.PI)]);
	return points;
}

const SIX: Point[] = [
	[0.9, 0.06],
	[0.6, 0],
	[0.3, 0.08],
	[0.08, 0.3],
	[0.02, 0.66],
	[0.12, 0.9],
	[0.35, 1],
	[0.65, 1],
	[0.9, 0.9],
	[0.98, 0.68],
	[0.88, 0.48],
	[0.62, 0.4],
	[0.35, 0.42],
	[0.08, 0.6],
];

/**
 * Each digit as marker strokes in a box 1 wide and 1 high (x to the right, y down).
 * The 4 has a closed top and a crossbar that sticks out to the right of the stem; the 7 is a bar
 * across the whole width and one slanted leg, with no foot and no flag, so it is not a 1.
 */
export const DIGIT_STROKES: Record<string, Point[][]> = {
	"0": [ellipse(0.5, 0.5, 0.48, 0.5)],
	"1": [
		[
			[0.15, 0.24],
			[0.55, 0],
			[0.55, 1],
		],
		[
			[0.12, 1],
			[0.98, 1],
		],
	],
	"2": [
		[
			[0.02, 0.24],
			[0.14, 0.07],
			[0.36, 0],
			[0.64, 0],
			[0.86, 0.07],
			[0.98, 0.24],
			[0.9, 0.44],
			[0, 1],
			[1, 1],
		],
	],
	"3": [
		[
			[0.03, 0.1],
			[0.3, 0],
			[0.7, 0],
			[0.95, 0.12],
			[0.95, 0.36],
			[0.7, 0.48],
			[0.35, 0.48],
		],
		[
			[0.7, 0.48],
			[0.98, 0.62],
			[0.98, 0.86],
			[0.7, 1],
			[0.3, 1],
			[0.02, 0.9],
		],
	],
	"4": [
		[
			[0.72, 1],
			[0.72, 0],
			[0, 0.7],
			[1, 0.7],
		],
	],
	"5": [
		[
			[0.92, 0],
			[0.1, 0],
			[0.05, 0.45],
			[0.35, 0.38],
			[0.68, 0.38],
			[0.95, 0.52],
			[0.98, 0.8],
			[0.72, 1],
			[0.3, 1],
			[0.02, 0.88],
		],
	],
	"6": [SIX],
	"7": [
		[
			[0, 0],
			[1, 0],
			[0.38, 1],
		],
	],
	"8": [ellipse(0.5, 0.25, 0.4, 0.25), ellipse(0.5, 0.74, 0.48, 0.26)],
	"9": [SIX.map(([x, y]): Point => [1 - x, 1 - y])],
};

/** Pixels: a digit's box, the marker's width, the space between digits and around the number. */
export const BOARD = { digitWidth: 150, digitHeight: 240, stroke: 34, gap: 80, margin: 90 };

/** Width and height of the picture of `text`. */
export function whiteboardSize(text: string): { width: number; height: number } {
	const n = Math.max(1, text.length);
	return { width: BOARD.margin * 2 + n * BOARD.digitWidth + (n - 1) * BOARD.gap, height: BOARD.margin * 2 + BOARD.digitHeight };
}

/** The picture as rows of pixels: true where the marker went. */
export function whiteboardInk(text: string): boolean[][] {
	const { width, height } = whiteboardSize(text);
	const ink = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
	const r = BOARD.stroke / 2;
	[...text].forEach((ch, i) => {
		const left = BOARD.margin + i * (BOARD.digitWidth + BOARD.gap);
		for (const stroke of DIGIT_STROKES[ch] ?? []) {
			const pts = stroke.map(([x, y]): Point => [left + x * BOARD.digitWidth, BOARD.margin + y * BOARD.digitHeight]);
			for (let k = 0; k + 1 < pts.length; k++) {
				const [ax, ay] = pts[k];
				const [bx, by] = pts[k + 1];
				const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
				for (let y = Math.max(0, Math.floor(Math.min(ay, by) - r)); y <= Math.min(height - 1, Math.ceil(Math.max(ay, by) + r)); y++) {
					for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - r)); x <= Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r)); x++) {
						// Distance from the pixel to the segment: a round marker of radius r.
						const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
						if ((x - (ax + t * (bx - ax))) ** 2 + (y - (ay + t * (by - ay))) ** 2 <= r * r) ink[y][x] = true;
					}
				}
			}
		}
	});
	return ink;
}

/** A white PNG with `text` (digits) written on it in black marker: a stand-in for a whiteboard photo. */
export function whiteboardPng(text: string): ArrayBuffer {
	const { width: w, height: h } = whiteboardSize(text);
	const ink = whiteboardInk(text);
	// Rows of RGB, each led by the filter byte 0.
	const raw = Buffer.alloc((w * 3 + 1) * h, 255);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		for (let x = 0; x < w; x++) if (ink[y][x]) raw.fill(20, y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 1 + x * 3 + 3);
	}
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (b: Buffer) => {
		let c = 0xffffffff;
		for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
	return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
}
