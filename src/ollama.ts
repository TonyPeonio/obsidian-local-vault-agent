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
	};
	keep_alive?: string;
	signal?: AbortSignal;
	onDelta?(delta: { content?: string; thinking?: string }): void;
}

export interface ChatResponse {
	message: ChatMessage;
	doneReason?: string;
	promptTokens?: number;
	completionTokens?: number;
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
 * Minimal Ollama HTTP client: streaming chat with tool calls, embeddings and model listing.
 */
export class OllamaClient {
	constructor(
		private getBaseUrl: () => string,
		private fetchImpl: FetchLike = (...args) => fetch(...args),
		private fallbackPost?: FallbackPost,
	) {}

	get baseUrl(): string {
		return this.getBaseUrl().replace(/\/+$/, "");
	}

	async version(): Promise<string> {
		const res = await this.get("/api/version");
		return String(res.version ?? "unknown");
	}

	async listModels(): Promise<ModelInfo[]> {
		const res = await this.get("/api/tags");
		const models = Array.isArray(res.models) ? res.models : [];
		return models.map((m: Record<string, unknown>) => {
			const details = (m.details ?? {}) as Record<string, unknown>;
			return {
				name: String(m.name),
				size: Number(m.size ?? 0),
				parameterSize: details.parameter_size ? String(details.parameter_size) : undefined,
				capabilities: Array.isArray(m.capabilities) ? (m.capabilities as string[]) : undefined,
			};
		});
	}

	/** Returns capability tags for a model ("tools", "thinking", "embedding", ...). */
	async showCapabilities(model: string): Promise<string[]> {
		const res = await this.post("/api/show", { model });
		return Array.isArray(res.capabilities) ? (res.capabilities as string[]) : [];
	}

	async embed(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
		if (inputs.length === 0) return [];
		const res = await this.post("/api/embed", { model, input: inputs }, signal);
		const embeddings = res.embeddings;
		if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) {
			throw new OllamaError("Ollama returned an unexpected embeddings payload");
		}
		return embeddings as number[][];
	}

	async chat(req: ChatRequest): Promise<ChatResponse> {
		const body: Record<string, unknown> = {
			model: req.model,
			messages: req.messages.map(toWireMessage),
			stream: true,
			options: req.options ?? {},
		};
		if (req.tools && req.tools.length > 0) body.tools = req.tools;
		if (req.think !== undefined) body.think = req.think;
		if (req.keep_alive) body.keep_alive = req.keep_alive;

		const url = `${this.baseUrl}/api/chat`;
		let response: Response;
		try {
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
				const r = await this.fallbackPost(url, JSON.stringify(body));
				if (r.status >= 400) throw new OllamaError(extractError(r.text, r.status), r.status);
				const json = JSON.parse(r.text);
				const message = fromWireMessage(json.message ?? {});
				req.onDelta?.({ content: message.content, thinking: message.thinking });
				return {
					message,
					doneReason: json.done_reason,
					promptTokens: json.prompt_eval_count,
					completionTokens: json.eval_count,
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

		for await (const chunk of ndjson(response.body, req.signal)) {
			if (chunk.error) throw new OllamaError(String(chunk.error));
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
			}
		}

		if (thinking) message.thinking = thinking;
		if (toolCalls.length) message.tool_calls = toolCalls;
		return { message, doneReason, promptTokens, completionTokens };
	}

	private async get(path: string): Promise<Record<string, unknown>> {
		const url = `${this.baseUrl}${path}`;
		try {
			const res = await this.fetchImpl(url);
			if (!res.ok) throw new OllamaError(extractError(await res.text(), res.status), res.status);
			return (await res.json()) as Record<string, unknown>;
		} catch (err) {
			if (err instanceof OllamaError) throw err;
			if (this.fallbackPost) {
				// requestUrl-based fallback only supports POST in our interface; GET endpoints
				// in Ollama also accept POST with an empty body for /api/tags and /api/version.
				const r = await this.fallbackPost(url, "");
				if (r.status >= 400) throw new OllamaError(extractError(r.text, r.status), r.status);
				return JSON.parse(r.text);
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
		try {
			const res = await this.fetchImpl(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
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
				return JSON.parse(r.text);
			}
			throw new OllamaError(
				`Cannot reach Ollama at ${this.baseUrl}. Is it running? (${(err as Error).message})`,
			);
		}
	}
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
	const out: Record<string, unknown> = { role: m.role, content: m.content };
	if (m.thinking) out.thinking = m.thinking;
	if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
	if (m.role === "tool" && m.tool_name) out.tool_name = m.tool_name;
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
		const json = JSON.parse(text);
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
				yield JSON.parse(line);
			}
		}
		const rest = buffer.trim();
		if (rest) yield JSON.parse(rest);
	} finally {
		reader.releaseLock();
	}
}
