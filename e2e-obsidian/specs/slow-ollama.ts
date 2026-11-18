import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import type { AddressInfo } from "net";

/** One scripted model reply: a tool call, or text streamed a piece at a time with a pause between pieces. */
export type SlowReply = { tool: string; args: Record<string, unknown> } | { content: string; pieceMs?: number };

/**
 * A stand-in for Ollama that streams like a model does: text arrives a few characters at a time,
 * with a pause between the pieces, and the last chunk carries counts and timings. For the specs
 * that need a reply to still be arriving while they look at the chat (streaming, the queue, Stop).
 * The model it lists can see, so pictures can be attached. Records the chat requests it got.
 */
export class SlowOllama {
	private server: Server | null = null;
	private replies: SlowReply[] = [];
	readonly chats: Record<string, unknown>[] = [];
	url = "";

	script(replies: SlowReply[]): void {
		this.replies = [...replies];
	}

	/** The text of the last user message of chat request `index` (negative counts from the end). */
	lastUserMessage(index = -1): string {
		const chat = this.chats.at(index);
		const messages = (chat?.messages ?? []) as { role: string; content: string }[];
		return messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
	}

	async start(): Promise<string> {
		this.server = createServer((req, res) => void this.handle(req, res));
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
		return this.url;
	}

	async stop(): Promise<void> {
		this.server?.closeAllConnections();
		await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
	}

	private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		// The chat is streamed with fetch from Obsidian's app:// origin, so CORS headers are needed.
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Headers", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		if (req.method === "OPTIONS") {
			res.writeHead(204).end();
			return;
		}
		const path = (req.url ?? "").split("?")[0];
		const json = (data: unknown) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(data));
		};
		if (path === "/api/version") return json({ version: "0.0.0-mock" });
		if (path === "/api/tags") return json({ models: [{ name: "mock-model:latest", size: 1, details: { parameter_size: "1B" }, capabilities: ["completion", "tools", "vision"] }] });
		if (path === "/api/ps") return json({ models: [{ name: "mock-model:latest", size: 1, size_vram: 1 }] });
		if (path === "/api/show") return json({ capabilities: ["completion", "tools", "vision"] });
		if (path === "/api/chat") {
			const sent = await this.body(req);
			res.writeHead(200, { "Content-Type": "application/x-ndjson" });
			// A one-token warm-up request is not a turn and takes none of the scripted replies.
			if ((sent.options as { num_predict?: number } | undefined)?.num_predict === 1) {
				res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "length", prompt_eval_count: 100, eval_count: 1 }) + "\n");
				return;
			}
			this.chats.push(sent);
			const reply = this.replies.shift() ?? { content: "(no scripted reply left)" };
			let pieces = 0;
			const started = Date.now();
			if ("tool" in reply) {
				res.write(JSON.stringify({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: reply.tool, arguments: reply.args } }] }, done: false }) + "\n");
			} else {
				for (const piece of reply.content.match(/[\s\S]{1,12}/g) ?? []) {
					// The chat stopped the turn: the connection is gone.
					if (res.destroyed) return;
					res.write(JSON.stringify({ message: { role: "assistant", content: piece }, done: false }) + "\n");
					pieces++;
					if (reply.pieceMs) await new Promise((r) => setTimeout(r, reply.pieceMs));
				}
			}
			if (res.destroyed) return;
			// Durations are nanoseconds, as Ollama reports them.
			res.end(
				JSON.stringify({
					message: { role: "assistant", content: "" },
					done: true,
					done_reason: "stop",
					prompt_eval_count: 1200,
					eval_count: Math.max(1, pieces),
					load_duration: 5_000_000,
					prompt_eval_duration: 40_000_000,
					eval_duration: Math.max(1, Date.now() - started) * 1_000_000,
				}) + "\n",
			);
			return;
		}
		res.writeHead(404).end("{}");
	}
}
