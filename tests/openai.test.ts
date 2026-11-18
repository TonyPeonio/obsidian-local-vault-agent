import { describe, expect, it } from "vitest";
import { OllamaClient } from "../src/ollama";
import { ToolCallAccumulator, embeddingVectors, fromOpenAIChoice, modelIds, openAIOptions, sse, toOpenAIMessages } from "../src/openai";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(c) {
			for (const ch of chunks) c.enqueue(enc.encode(ch));
			c.close();
		},
	});
}

describe("OpenAI wire format", () => {
	it("gives tool calls ids and points tool results at them", () => {
		const out = toOpenAIMessages([
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "", tool_calls: [{ function: { name: "read_note", arguments: { path: "A" } } }, { id: "x9", function: { name: "grep_vault", arguments: {} } }] },
			{ role: "tool", content: "A text", tool_name: "read_note" },
			{ role: "tool", content: "grep", tool_name: "grep_vault", tool_call_id: "x9" },
			{ role: "user", content: "look", images: ["AAA"] },
		]);
		expect(out[2]).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [
				{ id: "call_0", type: "function", function: { name: "read_note", arguments: '{"path":"A"}' } },
				{ id: "x9", type: "function", function: { name: "grep_vault", arguments: "{}" } },
			],
		});
		expect(out[3]).toEqual({ role: "tool", tool_call_id: "call_0", content: "A text" });
		expect(out[4]).toEqual({ role: "tool", tool_call_id: "x9", content: "grep" });
		expect(out[5]).toEqual({ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] });
	});

	it("parses server-sent events across chunk boundaries, stopping at [DONE]", async () => {
		const got: unknown[] = [];
		for await (const e of sse(stream(['data: {"a":', '1}\n\n: comment\ndata: {"a":2}\n', "data: [DONE]\n", 'data: {"a":3}\n']))) got.push(e);
		expect(got).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("assembles tool calls streamed in pieces", () => {
		const acc = new ToolCallAccumulator();
		acc.add([{ index: 0, id: "c1", function: { name: "read_", arguments: '{"pa' } }]);
		acc.add([{ index: 0, function: { name: "note", arguments: 'th":"A"}' } }, { index: 1, function: { name: "grep_vault", arguments: "not json" } }]);
		expect(acc.calls()).toEqual([
			{ id: "c1", function: { name: "read_note", arguments: { path: "A" } } },
			// Arguments that are not JSON are kept as a marker, so the agent can say "invalid JSON" and not "missing argument".
			{ id: "call_1", function: { name: "grep_vault", arguments: { __invalid_json: "not json" } } },
		]);
	});

	it("reads a non-streamed choice, models, embeddings and options", () => {
		expect(fromOpenAIChoice({ choices: [{ message: { content: "hi", reasoning_content: "hmm", tool_calls: [{ id: "q", function: { name: "f", arguments: "{}" } }] } }] })).toEqual({ role: "assistant", content: "hi", thinking: "hmm", tool_calls: [{ id: "q", function: { name: "f", arguments: {} } }] });
		expect(modelIds({ data: [{ id: "a" }, { id: "b" }, {}] })).toEqual(["a", "b"]);
		expect(embeddingVectors({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }, 2)).toEqual([[1], [2]]);
		expect(embeddingVectors({ data: [] }, 1)).toBeNull();
		expect(openAIOptions({ temperature: 0.6, top_k: 20, num_predict: 100 })).toEqual({ temperature: 0.6, top_k: 20, max_tokens: 100 });
	});
});

describe("OllamaClient with an OpenAI-compatible server", () => {
	function client(handler: (url: string, init?: RequestInit) => Response, key = "") {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return handler(url, init);
		}) as unknown as typeof fetch;
		return { c: new OllamaClient(() => "http://localhost:1234/v1/", fetchImpl, undefined, undefined, () => ({ kind: "openai", apiKey: key })), calls };
	}

	it("streams a chat with content and a tool call, sending the key", async () => {
		const body = [
			'data: {"choices":[{"delta":{"content":"Let me "}}]}\n',
			'data: {"choices":[{"delta":{"content":"look."}}]}\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"search_notes","arguments":"{\\"query\\":"}}]}}]}\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"chess\\"}"}}]},"finish_reason":"tool_calls"}]}\n',
			'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":7}}\n',
			"data: [DONE]\n",
		];
		const { c, calls } = client(() => new Response(stream(body)), "secret");
		const deltas: string[] = [];
		const res = await c.chat({ model: "qwen", messages: [{ role: "user", content: "hi" }], options: { temperature: 0.5, num_ctx: 8192 }, onDelta: (d) => d.content && deltas.push(d.content) });
		expect(calls[0].url).toBe("http://localhost:1234/v1/chat/completions");
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer secret");
		const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
		expect(sent).toMatchObject({ model: "qwen", stream: true, temperature: 0.5 });
		expect(sent.num_ctx).toBeUndefined();
		expect(deltas.join("")).toBe("Let me look.");
		expect(res.message.tool_calls).toEqual([{ id: "t1", function: { name: "search_notes", arguments: { query: "chess" } } }]);
		expect(res).toMatchObject({ doneReason: "tool_calls", promptTokens: 50, completionTokens: 7 });
	});

	it("lists models and embeds through /v1", async () => {
		const { c, calls } = client((url) =>
			url.endsWith("/models")
				? new Response(JSON.stringify({ data: [{ id: "qwen" }, { id: "nomic-embed" }] }))
				: new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] })),
		);
		expect((await c.listModels()).map((m) => m.name)).toEqual(["qwen", "nomic-embed"]);
		expect(await c.version()).toBe("OpenAI-compatible");
		expect(await c.embed("nomic-embed", ["x"])).toEqual([[0.1, 0.2]]);
		expect(calls.map((x) => x.url)).toEqual(["http://localhost:1234/v1/models", "http://localhost:1234/v1/models", "http://localhost:1234/v1/embeddings"]);
		expect(await c.ps()).toEqual([]);
		await expect(c.pull("x", () => {})).rejects.toThrow(/Ollama only/);
	});

	const SSE_OK = ['data: {"choices":[{"delta":{"content":"{\\"a\\":1}"}}]}\n', "data: [DONE]\n"];
	/** A client whose `fetch` is blocked (CORS), so everything goes through the plain request, as in Obsidian. */
	function plainClient(plain: (url: string, body?: string) => Promise<{ status: number; text: string }>) {
		const bodies: string[] = [];
		const fetchImpl = (async () => {
			throw new TypeError("Failed to fetch");
		}) as unknown as typeof fetch;
		const c = new OllamaClient(
			() => "http://localhost:1234",
			fetchImpl,
			undefined,
			(url, _method, body) => {
				bodies.push(body ?? "");
				return plain(url, body);
			},
			() => ({ kind: "openai" }),
		);
		return { c, bodies };
	}

	it("asks again without response_format when the server rejects json_object (LM Studio)", async () => {
		const { c, calls } = client((_url, init) =>
			String(init?.body).includes("response_format") ? new Response(JSON.stringify({ error: "'response_format.type' must be 'json_schema' or 'text'" }), { status: 400 }) : new Response(stream(SSE_OK)),
		);
		const res = await c.chat({ model: "qwen", messages: [{ role: "user", content: "quiz" }], format: "json" });
		expect(res.message.content).toBe('{"a":1}');
		expect(calls).toHaveLength(2);
		expect(JSON.parse(String(calls[0].init?.body)).response_format).toEqual({ type: "json_object" });
		expect(JSON.parse(String(calls[1].init?.body)).response_format).toBeUndefined();
	});

	it("asks again without response_format on the plain-request path too, and only for that error", async () => {
		const { c, bodies } = plainClient(async (_url, body) =>
			body?.includes("response_format")
				? { status: 400, text: JSON.stringify({ error: { message: "'response_format.type' must be 'json_schema' or 'text'" } }) }
				: { status: 200, text: JSON.stringify({ choices: [{ message: { content: "{}" } }] }) },
		);
		expect((await c.chat({ model: "qwen", messages: [], format: "json" })).message.content).toBe("{}");
		expect(bodies).toHaveLength(2);
		const other = plainClient(async () => ({ status: 400, text: JSON.stringify({ error: "model not loaded" }) }));
		await expect(other.c.chat({ model: "qwen", messages: [], format: "json" })).rejects.toThrow("model not loaded");
		expect(other.bodies).toHaveLength(1);
	});

	it("stops waiting for the non-streamed fallback when the user presses Stop", async () => {
		const abort = new AbortController();
		// Stop is pressed while the request that cannot be cancelled is under way.
		const { c } = plainClient(() => {
			setTimeout(() => abort.abort(), 0);
			return new Promise(() => {});
		});
		const deltas: unknown[] = [];
		const pending = c.chat({ model: "qwen", messages: [], signal: abort.signal, onDelta: (d) => deltas.push(d) });
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(deltas).toEqual([]);
	});

	it("says the server cannot be reached when the fallback request fails too", async () => {
		const { c } = plainClient(async () => {
			throw new Error("net::ERR_CONNECTION_REFUSED");
		});
		await expect(c.chat({ model: "qwen", messages: [] })).rejects.toThrow(/Cannot reach the server at http:\/\/localhost:1234\. Is it running\? \(net::ERR_CONNECTION_REFUSED\)/);
	});

	it("treats an error sent with status 200 as an error, not as zero models or an empty answer", async () => {
		const { c } = plainClient(async (url) => ({ status: 200, text: JSON.stringify({ error: `Unexpected endpoint or method. (${url.endsWith("/models") ? "GET /models" : "POST /chat/completions"})` }) }));
		await expect(c.listModels()).rejects.toThrow("Unexpected endpoint or method. (GET /models)");
		await expect(c.version()).rejects.toThrow(/Unexpected endpoint/);
		await expect(c.chat({ model: "qwen", messages: [] })).rejects.toThrow("Unexpected endpoint or method. (POST /chat/completions)");
		const objectError = plainClient(async () => ({ status: 200, text: JSON.stringify({ error: { message: "no such route", code: 404 } }) }));
		await expect(objectError.c.listModels()).rejects.toThrow("no such route");
	});

	it("does not read a 200 reply without a model list as zero models", async () => {
		const { c } = plainClient(async () => ({ status: 200, text: JSON.stringify({ status: "ok" }) }));
		await expect(c.listModels()).rejects.toThrow(/did not return a model list\. Does the URL end in \/v1\?/);
		await expect(c.version()).rejects.toThrow(/did not return a model list/);
	});

	it("reads a plain JSON answer to a streamed chat: an error throws, a whole completion is returned", async () => {
		const json = { "Content-Type": "application/json; charset=utf-8" };
		const bad = client(() => new Response(JSON.stringify({ error: "Unexpected endpoint or method. (POST /chat/completions)" }), { headers: json }));
		await expect(bad.c.chat({ model: "qwen", messages: [] })).rejects.toThrow(/Unexpected endpoint or method/);
		const whole = client(() => new Response(JSON.stringify({ choices: [{ message: { content: "all at once" } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }), { headers: json }));
		const deltas: string[] = [];
		const res = await whole.c.chat({ model: "qwen", messages: [], onDelta: (d) => d.content && deltas.push(d.content) });
		expect(res).toMatchObject({ message: { role: "assistant", content: "all at once" }, promptTokens: 3, completionTokens: 4 });
		expect(deltas).toEqual(["all at once"]);
	});
});

describe("OllamaClient.pull", () => {
	it("reports download progress", async () => {
		const lines = ['{"status":"pulling manifest"}\n', '{"status":"pulling abc","total":200,"completed":50}\n', '{"status":"pulling abc","total":200,"completed":200}\n', '{"status":"success"}\n'];
		const fetchImpl = (async () => new Response(stream(lines))) as unknown as typeof fetch;
		const c = new OllamaClient(() => "http://localhost:11434", fetchImpl);
		const seen: (number | null)[] = [];
		await c.pull("nomic-embed-text", (f) => seen.push(f));
		expect(seen).toEqual([null, 0.25, 1, null]);
	});
});
