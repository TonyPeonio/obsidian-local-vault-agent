import { createServer, type IncomingMessage, type Server } from "http";
import type { AddressInfo } from "net";

/** One scripted model reply: a tool call, or the final text. */
export type Reply = { tool: string; args: Record<string, unknown> } | { content: string };

/**
 * A stand-in for Ollama: answers the endpoints the plugin calls and replays scripted chat replies
 * (streamed as newline-delimited JSON, like the real server). Records the chat requests it got.
 */
export class MockOllama {
	private server: Server | null = null;
	private replies: Reply[] = [];
	readonly chats: Record<string, unknown>[] = [];
	url = "";

	script(replies: Reply[]): void {
		this.replies = [...replies];
	}

	async start(): Promise<string> {
		this.server = createServer((req, res) => void this.handle(req, res));
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
		return this.url;
	}

	async stop(): Promise<void> {
		// Chromium keeps a spare connection open that never carried a request; `close()` alone waits
		// for it (for minutes), which timed out the "after all" hook in about two runs of three.
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

	private async handle(req: IncomingMessage, res: import("http").ServerResponse): Promise<void> {
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
		if (path === "/api/tags") return json({ models: [{ name: "mock-model:latest", size: 1, details: { parameter_size: "1B" }, capabilities: ["completion", "tools"] }] });
		if (path === "/api/ps") return json({ models: [] });
		if (path === "/api/show") return json({ capabilities: ["completion", "tools"] });
		if (path === "/api/chat") {
			this.chats.push(await this.body(req));
			const reply = this.replies.shift() ?? { content: "(no scripted reply left)" };
			res.writeHead(200, { "Content-Type": "application/x-ndjson" });
			if ("tool" in reply) {
				res.write(JSON.stringify({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: reply.tool, arguments: reply.args } }] }, done: false }) + "\n");
			} else {
				for (const piece of reply.content.match(/.{1,12}/gs) ?? []) res.write(JSON.stringify({ message: { role: "assistant", content: piece }, done: false }) + "\n");
			}
			res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 100, eval_count: 10 }) + "\n");
			return;
		}
		res.writeHead(404).end("{}");
	}
}
