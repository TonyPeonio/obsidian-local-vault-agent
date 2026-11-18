import { describe, expect, it } from "vitest";
import { downmix, encodeWav, resample, toWav16k } from "../src/audio";
import { imageEmbeds } from "../src/embeds";
import type { ChatRequest } from "../src/ollama";
import { OllamaError } from "../src/ollama";
import { readNote, readFile } from "../src/tools";
import type { ToolContext } from "../src/types";
import { ImageReader, arrayBufferToBase64, cacheKey, readImage, sha256Hex, type VisionData } from "../src/vision";
import { FakeVault } from "./fakes";

describe("image helpers", () => {
	it("encodes base64 like Buffer does, also for large data", () => {
		const small = new Uint8Array([0, 1, 2, 250, 255]).buffer;
		expect(arrayBufferToBase64(small)).toBe(Buffer.from(new Uint8Array(small)).toString("base64"));
		const big = new Uint8Array(200_000).map((_, i) => i % 256);
		expect(arrayBufferToBase64(big.buffer)).toBe(Buffer.from(big).toString("base64"));
	});

	it("hashes with SHA-256", async () => {
		expect(await sha256Hex(new TextEncoder().encode("abc").buffer as ArrayBuffer)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("lists embedded images in both link styles, once each", () => {
		const note = "![[board.png]] text ![[board.png|300]] ![[Scans/page 1.JPG]] ![[clip.m4a]] ![alt](img/a%20b.webp) ![x](https://e.com/p.png)";
		expect(imageEmbeds(note)).toEqual(["board.png", "Scans/page 1.JPG", "img/a b.webp"]);
	});

	it("keys the cache by hash, model, page and question", () => {
		expect(cacheKey("h", "m")).toBe("h|m||");
		expect(cacheKey("h", "m", 2, " What? ")).toBe("h|m|2|what?");
	});
});

function fakeClient(caps: string[], reply = "Text: E = mc^2\nDescription: a whiteboard.") {
	const requests: ChatRequest[] = [];
	const client = {
		requests,
		async showCapabilities() {
			return caps;
		},
		async chat(req: ChatRequest) {
			requests.push(req);
			if (req.think !== undefined && caps.includes("no-think")) throw new OllamaError('"m" does not support thinking');
			return { message: { role: "assistant", content: reply } };
		},
	};
	return client;
}

function reader(caps: string[], visionModel = "", data: { saved?: VisionData } = {}) {
	const client = fakeClient(caps);
	const r = new ImageReader({
		client: client as never,
		getVisionModel: () => visionModel,
		getChatModel: () => "qwen3.5:9b",
		keepAlive: () => "5m",
		readBinary: async (p) => new TextEncoder().encode(`bytes of ${p}`).buffer as ArrayBuffer,
		renderPdfPage: async (_p, page) => new TextEncoder().encode(`png of page ${page}`).buffer as ArrayBuffer,
		load: async () => data.saved ?? null,
		save: async (d) => void (data.saved = JSON.parse(JSON.stringify(d)) as VisionData),
	});
	return { r, client, data };
}

describe("ImageReader", () => {
	it("uses the chat model when it can see, sends the image base64, and caches by content", async () => {
		const { r, client, data } = reader(["completion", "vision", "tools"]);
		expect(await r.model()).toBe("qwen3.5:9b");
		const text = await r.describe("board.png");
		expect(text).toContain("E = mc^2");
		expect(client.requests[0].messages[0].images).toEqual([Buffer.from("bytes of board.png").toString("base64")]);
		await r.describe("board.png");
		expect(client.requests).toHaveLength(1);
		expect(Object.keys(data.saved!.entries)).toHaveLength(1);
	});

	it("renders a PDF page and caches pages separately", async () => {
		const { r, client } = reader(["vision"]);
		await r.describe("scan.pdf", { page: 3 });
		await r.describe("scan.pdf", { page: 4 });
		expect(client.requests).toHaveLength(2);
		expect(client.requests[0].messages[0].images).toEqual([Buffer.from("png of page 3").toString("base64")]);
	});

	it("has no model without vision, and explains; a configured model wins", async () => {
		const none = reader(["completion", "tools"]);
		expect(await none.r.model()).toBeNull();
		await expect(none.r.describe("a.png")).rejects.toThrow(/No vision model/);
		const set = reader(["completion"], "qwen2.5vl:7b");
		expect(await set.r.model()).toBe("qwen2.5vl:7b");
		await expect(set.r.describe("a.gif")).rejects.toThrow(/Cannot read \.gif/);
	});

	it("hands the stop signal to the model call, and does not make it part of the cache key", async () => {
		const { r, client, data } = reader(["vision"]);
		const stop = new AbortController();
		await r.describe("board.png", { signal: stop.signal });
		expect(client.requests[0].signal).toBe(stop.signal);
		// Read once: the same picture without a signal comes from the cache.
		await r.describe("board.png");
		expect(client.requests).toHaveLength(1);
		expect(Object.keys(data.saved!.entries)).toHaveLength(1);
	});

	it("retries without think for models that reject it", async () => {
		const { r, client } = reader(["vision", "no-think"]);
		await r.describe("x.jpg");
		expect(client.requests.map((q) => q.think)).toEqual([false, undefined]);
	});
});

describe("read_image and image hints", () => {
	const base = (vault: FakeVault, describe?: ToolContext["describeImage"]): ToolContext => ({ vault, search: async () => [], approve: async () => "approve", maxResultChars: 4000, describeImage: describe, readAttachmentText: async () => "--- Page 1 ---\nHello\n\n--- Page 2 ---\n\n\n--- Page 3 ---\n" });

	it("reads an attachment through describeImage", async () => {
		const vault = new FakeVault();
		vault.seedFile("Attachments/board.png");
		const calls: unknown[] = [];
		const out = await readImage.execute({ path: "![[board.png]]", question: "what formula?" }, base(vault, async (p, o) => (calls.push([p, o]), "Text: E=mc^2")));
		expect(out).toBe("# Attachments/board.png\n---\nText: E=mc^2");
		expect(calls).toEqual([["Attachments/board.png", { page: undefined, question: "what formula?" }]]);
		await expect(readImage.execute({ path: "nope.png" }, base(vault, async () => ""))).rejects.toThrow(/No file found/);
	});

	it("read_note mentions embedded images only when a vision model is there", async () => {
		const vault = new FakeVault({ "N.md": "Look: ![[board.png]]" });
		expect(await readNote.execute({ path: "N" }, base(vault, async () => ""))).toContain("embeds 1 image (board.png)");
		expect(await readNote.execute({ path: "N" }, base(vault))).not.toContain("embeds");
	});

	it("read_file points at scanned PDF pages", async () => {
		const vault = new FakeVault();
		vault.seedFile("scan.pdf");
		expect(await readFile.execute({ path: "scan.pdf" }, base(vault, async () => ""))).toContain("Pages 2, 3 have no text layer");
		expect(await readFile.execute({ path: "scan.pdf" }, base(vault))).not.toContain("text layer");
	});
});

describe("audio", () => {
	it("mixes channels down and resamples to 16 kHz", () => {
		expect(Array.from(downmix([new Float32Array([1, 0]), new Float32Array([0, 0])]))).toEqual([0.5, 0]);
		const r = resample(new Float32Array(48000).fill(0.25), 48000, 16000);
		expect(r.length).toBe(16000);
		expect(r[100]).toBeCloseTo(0.25);
		expect(resample(new Float32Array([0, 1]), 8000, 16000).length).toBe(4);
	});

	it("encodes a 16-bit mono PCM WAV", () => {
		const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
		const v = new DataView(wav);
		const tag = (at: number) => String.fromCharCode(...new Uint8Array(wav, at, 4));
		expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
		expect(v.getUint16(22, true)).toBe(1);
		expect(v.getUint32(24, true)).toBe(16000);
		expect(v.getUint32(40, true)).toBe(8);
		expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
		expect(toWav16k([new Float32Array(44100)], 44100).byteLength).toBe(44 + 16000 * 2);
	});
});
