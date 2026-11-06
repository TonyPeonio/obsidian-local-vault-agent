import type { ChatRequest, ChatResponse, OllamaClient } from "../src/ollama";
import type { ChatMessage, FileInfo, NoteInfo, NoteMetadata, ToolCall, VaultAccess } from "../src/types";

/** In-memory vault for tests and the end-to-end script. */
export class FakeVault implements VaultAccess {
	private files = new Map<string, { content: string; mtime: number; ctime: number }>();
	activePath: string | null = null;
	selection: string | null = null;
	private clock = 1_700_000_000_000;

	constructor(initial: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initial)) this.seed(path, content);
	}

	seed(path: string, content: string, mtime?: number): void {
		const t = mtime ?? (this.clock += 1000);
		this.files.set(path, { content, mtime: t, ctime: t });
	}

	listNotes(): NoteInfo[] {
		return Array.from(this.files.entries()).map(([path, f]) => ({
			path,
			basename: (path.split("/").pop() ?? path).replace(/\.md$/, ""),
			folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
			mtime: f.mtime,
			ctime: f.ctime,
			size: f.content.length,
		}));
	}

	resolve(pathOrName: string): string | null {
		let p = pathOrName.trim().replace(/^\[\[|\]\]$/g, "").replace(/^\/+/, "");
		if (this.files.has(p)) return p;
		if (!p.endsWith(".md") && this.files.has(p + ".md")) return p + ".md";
		p = p.replace(/\.md$/, "").toLowerCase();
		for (const path of this.files.keys()) {
			const base = (path.split("/").pop() ?? "").replace(/\.md$/, "").toLowerCase();
			if (base === p || path.toLowerCase() === p + ".md") return path;
		}
		return null;
	}

	exists(path: string): boolean {
		return this.files.has(path);
	}

	async read(path: string): Promise<string> {
		const f = this.files.get(path);
		if (!f) throw new Error(`Note not found: ${path}`);
		return f.content;
	}

	async create(path: string, content: string): Promise<void> {
		if (this.files.has(path)) throw new Error(`Already exists: ${path}`);
		this.seed(path, content);
	}

	async modify(path: string, content: string): Promise<void> {
		const f = this.files.get(path);
		if (!f) throw new Error(`Note not found: ${path}`);
		f.content = content;
		f.mtime = this.clock += 1000;
	}

	trashed: string[] = [];
	private attachments = new Map<string, { size: number; mtime: number; data?: ArrayBuffer }>();

	/** Register a non-markdown file; `data` is optional (the fake does not need real bytes). */
	seedFile(path: string, size = 1000, mtime?: number, data?: ArrayBuffer): void {
		this.attachments.set(path, { size, mtime: mtime ?? (this.clock += 1000), data });
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const f = this.attachments.get(path);
		if (!f) throw new Error(`File not found: ${path}`);
		return f.data ?? new ArrayBuffer(f.size);
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<void> {
		if (this.attachments.has(path) || this.files.has(path)) throw new Error(`Already exists: ${path}`);
		this.seedFile(path, data.byteLength, undefined, data);
	}

	listAttachments(): FileInfo[] {
		return Array.from(this.attachments.entries()).map(([path, f]) => {
			const name = path.split("/").pop() ?? path;
			const dot = name.lastIndexOf(".");
			return {
				path,
				basename: dot > 0 ? name.slice(0, dot) : name,
				extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
				folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
				mtime: f.mtime,
				ctime: f.mtime,
				size: f.size,
			};
		});
	}

	resolveFile(path: string): string | null {
		const p = path.trim().replace(/^!?\[\[|\]\]$/g, "").replace(/^\/+/, "");
		if (this.files.has(p) || this.attachments.has(p)) return p;
		for (const other of this.attachments.keys()) {
			if ((other.split("/").pop() ?? "") === p) return other;
		}
		return this.resolve(p);
	}

	async trash(path: string): Promise<void> {
		if (this.files.has(path)) this.files.delete(path);
		else if (this.attachments.has(path)) this.attachments.delete(path);
		else throw new Error(`File not found: ${path}`);
		this.trashed.push(path);
	}

	getMetadata(path: string): NoteMetadata {
		const content = this.files.get(path)?.content ?? "";
		const tags = Array.from(new Set(Array.from(content.matchAll(/(^|\s)(#[\p{L}\p{N}_/-]+)/gu)).map((m) => m[2])));
		const fm = content.match(/^---\n([\s\S]*?)\n---/);
		const fmTags = fm?.[1].match(/^tags:\s*\[(.*)\]/m)?.[1].split(",").map((t) => "#" + t.trim()) ?? [];
		const links = Array.from(content.matchAll(/\[\[([^\]|#]+)/g)).map((m) => m[1]);
		const backlinks: string[] = [];
		const me = (path.split("/").pop() ?? "").replace(/\.md$/, "");
		for (const [other, f] of this.files) {
			if (other !== path && new RegExp(`\\[\\[${me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\||\\]|#)`).test(f.content)) {
				backlinks.push(other);
			}
		}
		const headings = Array.from(content.matchAll(/^(#{1,6}) (.+)$/gm)).map((m) => `${m[1]} ${m[2]}`);
		return { tags: [...tags, ...fmTags], links, backlinks, headings, frontmatter: {} };
	}

	getActiveNotePath(): string | null {
		return this.activePath;
	}
	getSelection(): string | null {
		return this.selection;
	}
}

export type Scripted =
	| { content: string; thinking?: string }
	| { tool: string; args: Record<string, unknown>; content?: string }
	| { tools: { tool: string; args: Record<string, unknown> }[] }
	| { error: Error };

/** Ollama client that replays scripted turns and records what it was sent. */
export class FakeOllama {
	requests: ChatRequest[] = [];
	embedCalls: string[][] = [];
	private turns: Scripted[];

	constructor(turns: Scripted[], private dims = 8) {
		this.turns = [...turns];
	}

	asClient(): OllamaClient {
		return this as unknown as OllamaClient;
	}

	async chat(req: ChatRequest): Promise<ChatResponse> {
		this.requests.push(req);
		const turn = this.turns.shift();
		if (!turn) throw new Error("FakeOllama: no scripted turn left");
		if ("error" in turn) throw turn.error;
		const message: ChatMessage = { role: "assistant", content: "" };
		if ("tools" in turn) {
			message.tool_calls = turn.tools.map((t): ToolCall => ({ function: { name: t.tool, arguments: t.args } }));
		} else if ("tool" in turn) {
			message.content = turn.content ?? "";
			message.tool_calls = [{ function: { name: turn.tool, arguments: turn.args } }];
		} else {
			message.content = turn.content;
			if (turn.thinking) {
				message.thinking = turn.thinking;
				req.onDelta?.({ thinking: turn.thinking });
			}
			for (const piece of turn.content.match(/.{1,5}/gs) ?? []) req.onDelta?.({ content: piece });
		}
		return { message, doneReason: "stop" };
	}

	/** Deterministic pseudo-embeddings: bag-of-characters hashed into `dims` buckets. */
	async embed(_model: string, inputs: string[]): Promise<number[][]> {
		this.embedCalls.push(inputs);
		return inputs.map((text) => {
			const v = new Array(this.dims).fill(0);
			for (const word of text.toLowerCase().replace(/^search_(query|document): /, "").split(/\W+/)) {
				if (!word) continue;
				let h = 0;
				for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
				v[h % this.dims] += 1;
			}
			return v;
		});
	}

	async listModels() {
		return [{ name: "fake-model", size: 0 }];
	}
	async version() {
		return "0.0.0-fake";
	}
}
