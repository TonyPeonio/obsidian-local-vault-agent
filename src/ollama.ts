import { ToolCallAccumulator, embeddingVectors, fromOpenAIChoice, modelIds, openAIOptions, sse, toOpenAIMessages, type Provider } from "./openai";
import type { ChatMessage, OllamaToolSpec, ToolCall } from "./types";

export interface ModelInfo {
	name: string;
	size: number;
	parameterSize?: string;
	capabilities?: string[];
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	tools?: OllamaToolSpec[];
	/** Enable reasoning for thinking-capable models. Leave undefined to use the model default. */
	think?: boolean;
	options?: {
		num_ctx?: number;
		temperature?: number;
		top_p?: number;
		top_k?: number;
		presence_penalty?: number;
		repeat_penalty?: number;
		num_predict?: number;
	};
	keep_alive?: string;
	/** "json", or a JSON schema, to constrain the reply (structured output). */
	format?: "json" | Record<string, unknown>;
	signal?: AbortSignal;
	onDelta?(delta: { content?: string; thinking?: string }): void;
}

export interface ChatResponse {
	message: ChatMessage;
	doneReason?: string;
	promptTokens?: number;
	completionTokens?: number;
	/** Nanoseconds, as Ollama reports them; present on the final chunk. */
	loadDuration?: number;
	promptEvalDuration?: number;
	evalDuration?: number;
}

/** A model currently loaded by Ollama (`/api/ps`). */
export interface RunningModel {
	name: string;
	/** Total memory the model plus its context take, in bytes. */
	size: number;
	/** The part of `size` that is on the GPU; the rest is in system RAM. */
	sizeVram: number;
	contextLength?: number;
}

export class OllamaError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "OllamaError";
	}
}

/**
 * Non-streaming POST used as a fallback when `fetch` is blocked (CORS). Obsidian's
 * `requestUrl` bypasses CORS but cannot stream. Injected so this file stays
 * free of Obsidian imports.
 */
export type FallbackPost = (
	url: string,
	body: string,
) => Promise<{ status: number; text: string }>;

type FetchLike = typeof fetch;

/**
 * A plain (non-streaming) HTTP request; in Obsidian this is `requestUrl`, which avoids CORS and is
 * what the plugin guidelines ask for. Injected so this file stays free of Obsidian imports.
 */
export type PlainRequest = (url: string, method: "GET" | "POST", body?: string, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;

/** Which server the client talks to, and its key when it wants one (OpenAI-compatible servers only). */
export interface ProviderConfig {
	kind: Provider;
	apiKey?: string;
}

/**
 * The global `fetch`, used only where a reply has to be streamed (chat tokens, model download
 * progress): Obsidian's `requestUrl` returns the whole body at once, and a slow local model
 * streaming its answer is the experience the chat is built on.
 */
const streamingFetch: FetchLike = (...args) => window.fetch(...args);

/**
 * Minimal Ollama HTTP client: streaming chat with tool calls, embeddings and model listing.
 */
export class OllamaClient {
	constructor(
		private getBaseUrl: () => string,
		private fetchImpl: FetchLike = streamingFetch,
		private fallbackPost?: FallbackPost,
		private plainRequest?: PlainRequest,
		private getProvider: () => ProviderConfig = () => ({ kind: "ollama" }),
	) {}

	get baseUrl(): string {
		return this.getBaseUrl().replace(/\/+$/, "");
	}

	/** "ollama" or "openai" (an OpenAI-compatible server: LM Studio, llama.cpp, Jan, vLLM). */
	get provider(): Provider {
		return this.getProvider().kind;
	}

	private headers(): Record<string, string> {
		const key = this.getProvider().apiKey?.trim();
		return key ? { Authorization: `Bearer ${key}` } : {};
	}

	async version(): Promise<string> {
		if (this.provider === "openai") {
			await this.openAIModels();
			return "OpenAI-compatible";
		}
		const res = await this.get("/api/version");
		return typeof res.version === "string" ? res.version : "unknown";
	}

	/**
	 * `/models` of an OpenAI-compatible server. A 2xx reply that is not a model list (some other
	 * route or server answering, typically a URL without /v1) is an error, not "0 models".
	 */
	private async openAIModels(): Promise<Record<string, unknown>> {
		const res = await this.get("/models");
		if (!Array.isArray(res.data)) throw new OllamaError(`${this.baseUrl} did not return a model list. Does the URL end in /v1?`);
		return res;
	}

	async listModels(): Promise<ModelInfo[]> {
		if (this.provider === "openai") return modelIds(await this.openAIModels()).map((name) => ({ name, size: 0 }));
		const res = await this.get("/api/tags");
		const models = Array.isArray(res.models) ? res.models : [];
		return models.map((m: Record<string, unknown>) => {
			const details = (m.details ?? {}) as Record<string, unknown>;
			return {
				name: String(m.name),
				size: Number(m.size ?? 0),
				parameterSize: typeof details.parameter_size === "string" ? details.parameter_size : undefined,
				capabilities: Array.isArray(m.capabilities) ? (m.capabilities as string[]) : undefined,
			};
		});
	}

	/** Models Ollama currently has loaded, with how much of each sits on the GPU. */
	async ps(): Promise<RunningModel[]> {
		if (this.provider === "openai") return [];
		const res = await this.get("/api/ps");
		const models = Array.isArray(res.models) ? res.models : [];
		return models.map((m: Record<string, unknown>) => ({
			name: typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : "",
			size: Number(m.size ?? 0),
			sizeVram: Number(m.size_vram ?? 0),
			contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
		}));
	}

	/** Returns capability tags for a model ("tools", "thinking", "embedding", ...). */
	async showCapabilities(model: string): Promise<string[]> {
		// OpenAI-compatible servers do not say; tool calling is assumed, vision must be set explicitly.
		if (this.provider === "openai") return ["completion", "tools"];
		const res = await this.post("/api/show", { model });
		return Array.isArray(res.capabilities) ? (res.capabilities as string[]) : [];
	}

	async embed(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
		if (inputs.length === 0) return [];
		if (this.provider === "openai") {
			const vecs = embeddingVectors(await this.post("/embeddings", { model, input: inputs }, signal), inputs.length);
			if (!vecs) throw new OllamaError("The server returned an unexpected embeddings payload");
			return vecs;
		}
		const res = await this.post("/api/embed", { model, input: inputs }, signal);
		const embeddings = res.embeddings;
		if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) {
			throw new OllamaError("Ollama returned an unexpected embeddings payload");
		}
		return embeddings as number[][];
	}

	async chat(req: ChatRequest): Promise<ChatResponse> {
		if (this.provider === "openai") {
			try {
				return await this.chatOpenAI(req);
			} catch (err) {
				// LM Studio accepts only response_format json_schema or text and answers 400 to json_object.
				// The 400 comes before any token, so asking again without it repeats nothing; callers that
				// want JSON also say so in the prompt.
				if (req.format && err instanceof OllamaError && err.status === 400 && /response_format/i.test(err.message)) {
					return this.chatOpenAI({ ...req, format: undefined });
				}
				throw err;
			}
		}
		const body: Record<string, unknown> = {
			model: req.model,
			messages: req.messages.map(toWireMessage),
			stream: true,
			options: req.options ?? {},
		};
		if (req.tools && req.tools.length > 0) body.tools = req.tools;
		if (req.think !== undefined) body.think = req.think;
		if (req.keep_alive) body.keep_alive = req.keep_alive;
		if (req.format) body.format = req.format;

		const url = `${this.baseUrl}/api/chat`;
		let response: Response;
		try {
			// `fetch` rather than `requestUrl` because only `fetch` can stream the reply.
			response = await this.fetchImpl(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: req.signal,
			});
		} catch (err) {
			if (req.signal?.aborted) throw err;
			// Typically a CORS / network failure. Fall back to a non-streaming request.
			if (this.fallbackPost) {
				body.stream = false;
				let r: { status: number; text: string };
				try {
					r = await abortable(this.fallbackPost(url, JSON.stringify(body)), req.signal);
				} catch (e) {
					if (req.signal?.aborted) throw e;
					throw new OllamaError(`Cannot reach Ollama at ${this.baseUrl}. Is it running? (${(e as Error).message})`);
				}
				if (r.status >= 400) throw new OllamaError(extractError(r.text, r.status), r.status);
				const json = JSON.parse(r.text) as Record<string, unknown>;
				const message = fromWireMessage((json.message ?? {}) as Record<string, unknown>);
				req.onDelta?.({ content: message.content, thinking: message.thinking });
				return {
					message,
					doneReason: typeof json.done_reason === "string" ? json.done_reason : undefined,
					promptTokens: typeof json.prompt_eval_count === "number" ? json.prompt_eval_count : undefined,
					completionTokens: typeof json.eval_count === "number" ? json.eval_count : undefined,
					...durations(json),
				};
			}
			throw new OllamaError(
				`Cannot reach Ollama at ${this.baseUrl}. Is it running? (${(err as Error).message})`,
			);
		}

		if (!response.ok) {
			const text = await response.text();
			throw new OllamaError(extractError(text, response.status), response.status);
		}
		if (!response.body) throw new OllamaError("Ollama returned an empty response body");

		const message: ChatMessage = { role: "assistant", content: "" };
		let thinking = "";
		const toolCalls: ToolCall[] = [];
		let doneReason: string | undefined;
		let promptTokens: number | undefined;
		let completionTokens: number | undefined;
		let timing: ReturnType<typeof durations> = {};

		for await (const chunk of ndjson(response.body, req.signal)) {
			if (chunk.error) {
				throw new OllamaError(typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error));
			}
			const m = (chunk.message ?? {}) as Record<string, unknown>;
			if (typeof m.content === "string" && m.content.length > 0) {
				message.content += m.content;
				req.onDelta?.({ content: m.content });
			}
			if (typeof m.thinking === "string" && m.thinking.length > 0) {
				thinking += m.thinking;
				req.onDelta?.({ thinking: m.thinking });
			}
			if (Array.isArray(m.tool_calls)) {
				for (const tc of m.tool_calls as Record<string, unknown>[]) {
					const call = normalizeToolCall(tc);
					if (call) toolCalls.push(call);
				}
			}
			if (chunk.done) {
				doneReason = chunk.done_reason as string | undefined;
				promptTokens = chunk.prompt_eval_count as number | undefined;
				completionTokens = chunk.eval_count as number | undefined;
				timing = durations(chunk);
			}
		}

		if (thinking) message.thinking = thinking;
		if (toolCalls.length) message.tool_calls = toolCalls;
		return { message, doneReason, promptTokens, completionTokens, ...timing };
	}

	/**
	 * Downloads a model into Ollama (`/api/pull`), reporting progress as a fraction (0–1, or null while
	 * the size is not known yet) and the status line Ollama sends.
	 */
	async pull(model: string, onProgress: (fraction: number | null, status: string) => void, signal?: AbortSignal): Promise<void> {
		if (this.provider !== "ollama") throw new OllamaError("Downloading models works with Ollama only; load the model in your server's own app.");
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, stream: true }), signal });
		} catch (err) {
			if (signal?.aborted) throw err;
			throw new OllamaError(`Cannot reach Ollama at ${this.baseUrl}. Is it running? (${(err as Error).message})`);
		}
		if (!response.ok) throw new OllamaError(extractError(await response.text(), response.status), response.status);
		if (!response.body) throw new OllamaError("Ollama returned an empty response body");
		for await (const chunk of ndjson(response.body, signal)) {
			if (chunk.error) throw new OllamaError(typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error));
			const total = typeof chunk.total === "number" ? chunk.total : 0;
			const done = typeof chunk.completed === "number" ? chunk.completed : 0;
			onProgress(total > 0 ? Math.min(1, done / total) : null, typeof chunk.status === "string" ? chunk.status : "");
		}
	}

	/** Chat through `/v1/chat/completions`, streamed (server-sent events), with tool calls. */
	private async chatOpenAI(req: ChatRequest): Promise<ChatResponse> {
		const body: Record<string, unknown> = {
			model: req.model,
			messages: toOpenAIMessages(req.messages),
			stream: true,
			stream_options: { include_usage: true },
			...openAIOptions(req.options),
		};
		if (req.tools?.length) body.tools = req.tools;
		if (req.format === "json") body.response_format = { type: "json_object" };
		const url = `${this.baseUrl}/chat/completions`;
		const headers = { "Content-Type": "application/json", ...this.headers() };
		let response: Response;
		try {
			response = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal });
		} catch (err) {
			if (req.signal?.aborted) throw err;
			if (this.plainRequest || this.fallbackPost) {
				body.stream = false;
				delete body.stream_options;
				const payload = JSON.stringify(body);
				let r: { status: number; text: string };
				try {
					r = await abortable(this.plainRequest ? this.plainRequest(url, "POST", payload, this.headers()) : this.fallbackPost!(url, payload), req.signal);
				} catch (e) {
					if (req.signal?.aborted) throw e;
					throw new OllamaError(`Cannot reach the server at ${this.baseUrl}. Is it running? (${(e as Error).message})`);
				}
				if (r.status >= 400) throw new OllamaError(extractError(r.text, r.status), r.status);
				return wholeOpenAIReply(parseJsonBody(r.text), req);
			}
			throw new OllamaError(`Cannot reach the server at ${this.baseUrl}. Is it running? (${(err as Error).message})`);
		}
		if (!response.ok) throw new OllamaError(extractError(await response.text(), response.status), response.status);
		if (!response.body) throw new OllamaError("The server returned an empty response body");
		// A plain JSON answer to a streamed request: an error sent with status 200 (LM Studio does this for an
		// unknown route, e.g. a URL without /v1) or a server that ignores `stream`. Read as events it would
		// have no `data:` line and look like an empty reply.
		if ((response.headers.get("content-type") ?? "").includes("application/json")) return wholeOpenAIReply(parseJsonBody(await response.text()), req);
		const message: ChatMessage = { role: "assistant", content: "" };
		let thinking = "";
		const calls = new ToolCallAccumulator();
		let doneReason: string | undefined;
		let promptTokens: number | undefined;
		let completionTokens: number | undefined;
		for await (const chunk of sse(response.body, req.signal)) {
			if (chunk.error) throw new OllamaError(typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error));
			const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as { delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown }; finish_reason?: unknown } | undefined;
			const d = choice?.delta ?? {};
			if (typeof d.content === "string" && d.content) {
				message.content += d.content;
				req.onDelta?.({ content: d.content });
			}
			if (typeof d.reasoning_content === "string" && d.reasoning_content) {
				thinking += d.reasoning_content;
				req.onDelta?.({ thinking: d.reasoning_content });
			}
			calls.add(d.tool_calls);
			if (typeof choice?.finish_reason === "string") doneReason = choice.finish_reason;
			const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
			if (usage) {
				promptTokens = usage.prompt_tokens;
				completionTokens = usage.completion_tokens;
			}
		}
		if (thinking) message.thinking = thinking;
		const toolCalls = calls.calls();
		if (toolCalls.length) message.tool_calls = toolCalls;
		return { message, doneReason, promptTokens, completionTokens };
	}

	private async get(path: string): Promise<Record<string, unknown>> {
		const url = `${this.baseUrl}${path}`;
		if (this.plainRequest) return this.viaPlain(url, "GET");
		try {
			const res = await this.fetchImpl(url, { headers: this.headers() });
			if (!res.ok) throw new OllamaError(extractError(await res.text(), res.status), res.status);
			return (await res.json()) as Record<string, unknown>;
		} catch (err) {
			if (err instanceof OllamaError) throw err;
			if (this.fallbackPost) {
				// requestUrl-based fallback only supports POST in our interface; GET endpoints
				// in Ollama also accept POST with an empty body for /api/tags and /api/version.
				const r = await this.fallbackPost(url, "");
				if (r.status >= 400) throw new OllamaError(extractError(r.text, r.status), r.status);
				return JSON.parse(r.text) as Record<string, unknown>;
			}
			throw new OllamaError(
				`Cannot reach Ollama at ${this.baseUrl}. Is it running? (${(err as Error).message})`,
			);
		}
	}

	private async post(
		path: string,
		body: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const url = `${this.baseUrl}${path}`;
		const payload = JSON.stringify(body);
		if (this.plainRequest) return this.viaPlain(url, "POST", payload);
		try {
			const res = await this.fetchImpl(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...this.headers() },
				body: payload,
				signal,
			});
			if (!res.ok) throw new OllamaError(extractError(await res.text(), res.status), res.status);
			return (await res.json()) as Record<string, unknown>;
		} catch (err) {
			if (err instanceof OllamaError) throw err;
			if (signal?.aborted) throw err;
			if (this.fallbackPost) {
				const r = await this.fallbackPost(url, payload);
				if (r.status >= 400) throw new OllamaError(extractError(r.text, r.status), r.status);
				return JSON.parse(r.text) as Record<string, unknown>;
			}
			throw new OllamaError(
				`Cannot reach Ollama at ${this.baseUrl}. Is it running? (${(err as Error).message})`,
			);
		}
	}

	private async viaPlain(url: string, method: "GET" | "POST", body?: string): Promise<Record<string, unknown>> {
		let r: { status: number; text: string };
		try {
			r = await this.plainRequest!(url, method, body, this.headers());
		} catch (err) {
			throw new OllamaError(`Cannot reach ${this.baseUrl}. Is it running? (${(err as Error).message})`);
		}
		if (r.status >= 400) throw new OllamaError(extractError(r.text, r.status), r.status);
		return parseJsonBody(r.text);
	}
}

/** The parsed body of a 2xx reply. An `error` in it is a failure all the same: some servers send theirs with status 200. */
function parseJsonBody(text: string): Record<string, unknown> {
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new OllamaError(`Unexpected reply from the server: ${text.slice(0, 200)}`);
	}
	if (json && typeof json === "object" && json.error) {
		const e = json.error as { message?: unknown };
		throw new OllamaError(typeof e === "string" ? e : typeof e.message === "string" ? e.message : JSON.stringify(e));
	}
	return json;
}

/** A completion that arrived whole (not streamed), handed to `onDelta` in one piece. */
function wholeOpenAIReply(json: Record<string, unknown>, req: ChatRequest): ChatResponse {
	const message = fromOpenAIChoice(json);
	req.onDelta?.({ content: message.content, thinking: message.thinking });
	const usage = (json.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
	return { message, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
}

/**
 * `p`, or an AbortError as soon as `signal` aborts. For Obsidian's `requestUrl`, which cannot be
 * cancelled: Stop frees the caller at once and the late reply is dropped (the server still finishes it).
 */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return p;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
		if (signal.aborted) {
			// Keep a handler on the abandoned request so its late failure is not an unhandled rejection.
			p.catch(() => {});
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function durations(chunk: Record<string, unknown>): Pick<ChatResponse, "loadDuration" | "promptEvalDuration" | "evalDuration"> {
	const num = (k: string) => {
		const v = chunk[k];
		return typeof v === "number" ? v : undefined;
	};
	const out: Pick<ChatResponse, "loadDuration" | "promptEvalDuration" | "evalDuration"> = {};
	const load = num("load_duration");
	const prompt = num("prompt_eval_duration");
	const evalD = num("eval_duration");
	if (load !== undefined) out.loadDuration = load;
	if (prompt !== undefined) out.promptEvalDuration = prompt;
	if (evalD !== undefined) out.evalDuration = evalD;
	return out;
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
	const out: Record<string, unknown> = { role: m.role, content: m.content };
	if (m.thinking) out.thinking = m.thinking;
	if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
	if (m.role === "tool" && m.tool_name) out.tool_name = m.tool_name;
	if (m.images?.length) out.images = m.images;
	return out;
}

function fromWireMessage(m: Record<string, unknown>): ChatMessage {
	const out: ChatMessage = {
		role: "assistant",
		content: typeof m.content === "string" ? m.content : "",
	};
	if (typeof m.thinking === "string" && m.thinking) out.thinking = m.thinking;
	if (Array.isArray(m.tool_calls)) {
		const calls = (m.tool_calls as Record<string, unknown>[])
			.map(normalizeToolCall)
			.filter((c): c is ToolCall => c !== null);
		if (calls.length) out.tool_calls = calls;
	}
	return out;
}

export function normalizeToolCall(raw: Record<string, unknown>): ToolCall | null {
	const fn = (raw.function ?? raw) as Record<string, unknown>;
	const name = fn.name;
	if (typeof name !== "string" || !name) return null;
	let args = fn.arguments;
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			args = {};
		}
	}
	if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
	return {
		id: typeof raw.id === "string" ? raw.id : undefined,
		function: { name, arguments: args as Record<string, unknown> },
	};
}

function extractError(text: string, status: number): string {
	try {
		const json = JSON.parse(text) as Record<string, unknown> | null;
		if (json && typeof json.error === "string") return json.error;
	} catch {
		// not JSON
	}
	return text?.trim() ? `${status}: ${text.trim().slice(0, 300)}` : `Ollama returned HTTP ${status}`;
}

/** Async iterator over newline-delimited JSON objects from a streaming body. */
export async function* ndjson(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) {
				await reader.cancel();
				throw new DOMException("Aborted", "AbortError");
			}
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (!line) continue;
				yield JSON.parse(line) as Record<string, unknown>;
			}
		}
		const rest = buffer.trim();
		if (rest) yield JSON.parse(rest) as Record<string, unknown>;
	} finally {
		reader.releaseLock();
	}
}

/** Ollama's canonical spelling: lower-case, without an explicit ":latest" tag. */
export function canonicalModelName(name: string): string {
	const n = name.trim().toLowerCase();
	return n.endsWith(":latest") ? n.slice(0, -":latest".length) : n;
}

/** Same model under either spelling: "nomic-embed-text" is "nomic-embed-text:latest", which is how `ollama list` reports it. */
export function sameModel(a: string, b: string): boolean {
	return canonicalModelName(a) === canonicalModelName(b);
}

/**
 * A one-line warning when the chat model is not fully on the GPU (Ollama's /api/ps reports how much
 * of it is in VRAM), or undefined when it is. A model that spills into system RAM runs several
 * times slower, and the usual cause is a context window too large for the card.
 */
export function placementWarning(running: RunningModel[], model: string): string | undefined {
	const m = running.find((r) => sameModel(r.name, model));
	if (!m || m.size <= 0 || m.sizeVram >= m.size * 0.98) return undefined;
	const gb = (n: number) => (n / 1e9).toFixed(1);
	const ctx = m.contextLength ? ` at a ${Math.round(m.contextLength / 1024)}k context` : "";
	return `${model} is only partly on the GPU (${gb(m.sizeVram)} of ${gb(m.size)} GB${ctx}); the rest runs from system RAM, several times slower. Lower the context window in settings (32768, or 16384 on an 8 GB card) or pick a smaller model such as qwen3.5:4b.`;
}
