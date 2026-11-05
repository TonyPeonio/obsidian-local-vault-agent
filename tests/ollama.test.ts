import { describe, expect, it } from "vitest";
import { OllamaClient, OllamaError, ndjson, normalizeToolCall } from "../src/ollama";

function streamOf(lines: object[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
	// Split at awkward byte boundaries to exercise buffering.
	const parts = [text.slice(0, 7), text.slice(7, 40), text.slice(40)];
	return new ReadableStream({
		start(controller) {
			for (const p of parts) controller.enqueue(enc.encode(p));
			controller.close();
		},
	});
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
	return ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch;
}

describe("ndjson", () => {
	it("yields one object per line regardless of chunking", async () => {
		const out = [];
		for await (const o of ndjson(streamOf([{ a: 1 }, { b: 2 }, { c: 3 }]))) out.push(o);
		expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});
});

describe("normalizeToolCall", () => {
	it("parses string arguments and tolerates missing fields", () => {
		expect(normalizeToolCall({ function: { name: "f", arguments: '{"x":1}' } })).toEqual({
			id: undefined,
			function: { name: "f", arguments: { x: 1 } },
		});
		expect(normalizeToolCall({ function: { name: "f" } })?.function.arguments).toEqual({});
		expect(normalizeToolCall({ function: { arguments: {} } })).toBeNull();
	});
});

describe("OllamaClient.chat", () => {
	it("streams content, thinking and tool calls", async () => {
		let sentBody = "";
		const client = new OllamaClient(
			() => "http://x/",
			fakeFetch((url, init) => {
				expect(url).toBe("http://x/api/chat");
				sentBody = String(init?.body);
				return new Response(
					streamOf([
						{ message: { role: "assistant", thinking: "hmm " }, done: false },
						{ message: { role: "assistant", content: "Hel" }, done: false },
						{ message: { role: "assistant", content: "lo" }, done: false },
						{ message: { role: "assistant", tool_calls: [{ function: { name: "search_notes", arguments: { query: "q" } } }] }, done: false },
						{ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5 },
					]),
				);
			}),
		);
		const deltas: string[] = [];
		const res = await client.chat({
			model: "m",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "search_notes", description: "d", parameters: { type: "object", properties: {} } } }],
			think: true,
			options: { num_ctx: 4096 },
			onDelta: (d) => deltas.push(d.content ?? d.thinking ?? ""),
		});
		expect(res.message.content).toBe("Hello");
		expect(res.message.thinking).toBe("hmm ");
		expect(res.message.tool_calls?.[0].function).toEqual({ name: "search_notes", arguments: { query: "q" } });
		expect(res.promptTokens).toBe(10);
		expect(deltas).toEqual(["hmm ", "Hel", "lo"]);
		const body = JSON.parse(sentBody);
		expect(body.stream).toBe(true);
		expect(body.think).toBe(true);
		expect(body.tools).toHaveLength(1);
		expect(body.options.num_ctx).toBe(4096);
	});

	it("surfaces Ollama error payloads", async () => {
		const client = new OllamaClient(
			() => "http://x",
			fakeFetch(() => new Response(JSON.stringify({ error: "model not found" }), { status: 404 })),
		);
		await expect(client.chat({ model: "m", messages: [] })).rejects.toThrow(OllamaError);
		await expect(client.chat({ model: "m", messages: [] })).rejects.toThrow("model not found");
	});

	it("falls back to the non-streaming poster when fetch fails", async () => {
		const client = new OllamaClient(
			() => "http://x",
			fakeFetch(() => {
				throw new TypeError("Failed to fetch");
			}),
			async (_url, body) => {
				expect(JSON.parse(body).stream).toBe(false);
				return { status: 200, text: JSON.stringify({ message: { role: "assistant", content: "via fallback" }, done: true }) };
			},
		);
		const res = await client.chat({ model: "m", messages: [] });
		expect(res.message.content).toBe("via fallback");
	});

	it("gives a clear error when Ollama is down and there is no fallback", async () => {
		const client = new OllamaClient(
			() => "http://x",
			fakeFetch(() => {
				throw new TypeError("Failed to fetch");
			}),
		);
		await expect(client.chat({ model: "m", messages: [] })).rejects.toThrow(/Cannot reach Ollama/);
	});

	it("sends tool results with tool_name on the wire", async () => {
		let sentBody = "";
		const client = new OllamaClient(
			() => "http://x",
			fakeFetch((_u, init) => {
				sentBody = String(init?.body);
				return new Response(streamOf([{ message: { role: "assistant", content: "ok" }, done: true }]));
			}),
		);
		await client.chat({
			model: "m",
			messages: [
				{ role: "user", content: "q" },
				{ role: "assistant", content: "", tool_calls: [{ function: { name: "t", arguments: {} } }] },
				{ role: "tool", content: "result", tool_name: "t" },
			],
		});
		const msgs = JSON.parse(sentBody).messages;
		expect(msgs[2]).toEqual({ role: "tool", content: "result", tool_name: "t" });
		expect(msgs[1].tool_calls).toHaveLength(1);
	});
});

describe("OllamaClient.embed / listModels", () => {
	it("returns embeddings and model info", async () => {
		const client = new OllamaClient(
			() => "http://x",
			fakeFetch((url) => {
				if (url.endsWith("/api/embed")) return new Response(JSON.stringify({ embeddings: [[1, 2], [3, 4]] }));
				if (url.endsWith("/api/tags")) {
					return new Response(JSON.stringify({ models: [{ name: "a:1", size: 5, details: { parameter_size: "7B" }, capabilities: ["tools"] }] }));
				}
				return new Response("{}", { status: 404 });
			}),
		);
		expect(await client.embed("e", ["x", "y"])).toEqual([[1, 2], [3, 4]]);
		expect(await client.embed("e", [])).toEqual([]);
		expect(await client.listModels()).toEqual([{ name: "a:1", size: 5, parameterSize: "7B", capabilities: ["tools"] }]);
	});
});
