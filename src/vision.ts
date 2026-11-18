import { IMAGE_EXTENSIONS } from "./embeds";
import { OllamaError, type OllamaClient } from "./ollama";
import { ToolError } from "./tools";
import type { ToolDefinition } from "./types";

/**
 * Reading images and scanned PDF pages with a local Ollama vision model (qwen2.5vl, qwen3.5,
 * llava, …): the picture goes base64 in the chat message's `images`, the model transcribes its
 * text and describes it, and the result is cached by the file's content hash so a picture is read
 * once. Without a vision model the tool is not offered at all. Pure apart from the injected I/O.
 */

/** Base64 of binary data, in chunks so a large image does not overflow the call stack. */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/** SHA-256 of the data as hex (Web Crypto, available in Obsidian and Node). */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", buf);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const VISION_PROMPT =
	"Read this image for someone who cannot see it. First transcribe every piece of text in it exactly as written (printed or handwritten, keeping line breaks, formulas in LaTeX), under 'Text:'. Then, under 'Description:', describe in a few sentences what it shows (diagram, chart with its axes and values, photo, slide). Do not guess at what is not visible.";

export interface VisionData {
	version: 1;
	/** cache key → description */
	entries: Record<string, { text: string; time: number }>;
}

export interface VisionDeps {
	client: OllamaClient;
	/** Vision model from settings; "" = use the chat model when it can see. */
	getVisionModel(): string;
	getChatModel(): string;
	keepAlive(): string;
	/** The chat's context size. An image read by the chat model itself asks for the same: a different size makes Ollama load the model again (21 s measured), and once more for the next chat request. */
	chatNumCtx?(): number;
	readBinary(path: string): Promise<ArrayBuffer>;
	/** PNG of one page of a PDF, for scanned pages; absent when PDFs cannot be rendered. */
	renderPdfPage?(path: string, page: number): Promise<ArrayBuffer>;
	load(): Promise<VisionData | null>;
	save(data: VisionData): Promise<void>;
}

/** Cached entries kept (oldest dropped). */
const MAX_ENTRIES = 2000;

export class ImageReader {
	private data: VisionData = { version: 1, entries: {} };
	private loaded = false;
	private capable = new Map<string, boolean>();

	constructor(private deps: VisionDeps) {}

	/** The model that will read images, or null when there is none ("" setting and a chat model without vision). */
	async model(): Promise<string | null> {
		const configured = this.deps.getVisionModel().trim();
		if (configured) return configured;
		const chat = this.deps.getChatModel();
		if (!this.capable.has(chat)) {
			try {
				this.capable.set(chat, (await this.deps.client.showCapabilities(chat)).includes("vision"));
			} catch {
				return null;
			}
		}
		return this.capable.get(chat) ? chat : null;
	}

	/** Forget the capability check (settings changed). */
	reset(): void {
		this.capable.clear();
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const d = await this.deps.load();
			if (d && d.version === 1 && d.entries) this.data = d;
		} catch {
			// start empty
		}
	}

	/** Text and description of an image, or of one page of a PDF. Cached by content hash, model, page and question. */
	async describe(path: string, opts: { page?: number; question?: string } = {}): Promise<string> {
		const model = await this.model();
		if (!model) throw new ToolError("No vision model is available. Install one (for example `ollama pull qwen2.5vl:7b`) and set it under Settings → Local Vault Agent → Vision model.");
		const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
		let image: ArrayBuffer;
		const raw = await this.deps.readBinary(path);
		if (ext === "pdf") {
			if (!this.deps.renderPdfPage) throw new ToolError("Rendering PDF pages is not available here.");
			image = await this.deps.renderPdfPage(path, Math.max(1, opts.page ?? 1));
		} else if (IMAGE_EXTENSIONS.includes(ext)) image = raw;
		else throw new ToolError(`Cannot read .${ext} images; PNG, JPEG, WebP and PDF pages are supported.`);
		await this.ensureLoaded();
		const key = cacheKey(await sha256Hex(raw), model, ext === "pdf" ? Math.max(1, opts.page ?? 1) : undefined, opts.question);
		const hit = this.data.entries[key];
		if (hit) return hit.text;
		const prompt = opts.question?.trim() ? `${VISION_PROMPT}\nAlso answer this question about it: ${opts.question.trim()}` : VISION_PROMPT;
		const text = await this.ask(model, prompt, arrayBufferToBase64(image));
		this.data.entries[key] = { text, time: Date.now() };
		const keys = Object.keys(this.data.entries);
		if (keys.length > MAX_ENTRIES) {
			keys.sort((a, b) => this.data.entries[a].time - this.data.entries[b].time);
			for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete this.data.entries[k];
		}
		await this.deps.save(this.data);
		return text;
	}

	private async ask(model: string, prompt: string, image: string): Promise<string> {
		let think: boolean | undefined = false;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res = await this.deps.client.chat({
					model,
					messages: [{ role: "user", content: prompt, images: [image] }],
					think,
					options: { num_ctx: model === this.deps.getChatModel() && this.deps.chatNumCtx ? this.deps.chatNumCtx() : 8192, temperature: 0.2 },
					keep_alive: this.deps.keepAlive(),
				});
				const text = res.message.content.trim();
				if (!text) throw new ToolError(`${model} returned nothing for this image.`);
				return text;
			} catch (err) {
				if (think !== undefined && err instanceof OllamaError && /think/i.test(err.message)) {
					think = undefined;
					continue;
				}
				if (err instanceof OllamaError && /image|vision|multimodal/i.test(err.message)) {
					throw new ToolError(`${model} cannot read images (${err.message}). Pick a vision model in settings, e.g. qwen2.5vl:7b.`);
				}
				throw err;
			}
		}
		throw new ToolError("The vision model did not answer.");
	}
}

export function cacheKey(hash: string, model: string, page?: number, question?: string): string {
	return [hash, model, page ?? "", (question ?? "").trim().toLowerCase()].join("|");
}

export const readImage: ToolDefinition = {
	name: "read_image",
	description:
		"Read an image or a scanned PDF page with the local vision model: transcribes the text in it (printed or handwritten) and describes diagrams, charts and photos. Use it for images a note embeds (![[photo.png]]) when their content matters, or for PDF pages read_file found no text on. Slow (seconds per image) but cached.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the image or PDF, e.g. 'Attachments/whiteboard.jpg'." },
			page: { type: "integer", description: "For a PDF: the page number (from 1)." },
			question: { type: "string", description: "Optional: what you want to know about the image." },
		},
		required: ["path"],
	},
	mutates: false,
	async execute(args, ctx) {
		const input = typeof args.path === "string" ? args.path : "";
		if (!input.trim()) throw new ToolError('Missing required argument "path".');
		if (!ctx.describeImage) throw new ToolError("No vision model is available.");
		const path = ctx.vault.resolveFile(input.trim().replace(/^!?\[\[|\]\]$/g, "").replace(/\|.*$/, ""));
		if (!path) throw new ToolError(`No file found for "${input}". Use list_files to find the exact path.`);
		const page = typeof args.page === "number" ? args.page : typeof args.page === "string" ? parseInt(args.page, 10) || undefined : undefined;
		const question = typeof args.question === "string" ? args.question : undefined;
		const text = await ctx.describeImage(path, { page, question });
		return `# ${path}${page ? ` (page ${page})` : ""}\n---\n${text}`;
	},
};
