import { INVALID_ARGUMENTS, type ChatMessage, type ToolCall } from "./types";

/**
 * The OpenAI-compatible wire format (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`) that
 * LM Studio, llama.cpp's server, Jan and vLLM speak. Only the translation lives here (messages
 * out, streamed deltas in); the HTTP calls are in `OllamaClient`, which switches on the provider.
 * Pure: no I/O.
 */

export type Provider = "ollama" | "openai";

/** Our conversation in OpenAI's shape: tool calls carry ids and tool results point back at them. */
export function toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	/** Ids of the last assistant message's calls that have not been answered yet, in order. */
	let open: string[] = [];
	let n = 0;
	for (const m of messages) {
		if (m.role === "assistant") {
			const calls = (m.tool_calls ?? []).map((c) => ({ ...c, id: c.id ?? `call_${n++}` }));
			open = calls.map((c) => c.id);
			const msg: Record<string, unknown> = { role: "assistant", content: m.content || (calls.length ? null : "") };
			if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } }));
			out.push(msg);
		} else if (m.role === "tool") {
			const id = m.tool_call_id && open.includes(m.tool_call_id) ? m.tool_call_id : (open[0] ?? `call_${n++}`);
			open = open.filter((x) => x !== id);
			out.push({ role: "tool", tool_call_id: id, content: m.content });
		} else if (m.images?.length) {
			out.push({ role: m.role, content: [{ type: "text", text: m.content }, ...m.images.map((b64) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }))] });
		} else out.push({ role: m.role, content: m.content });
	}
	return out;
}

/** Server-sent events from a streaming body: each `data:` payload parsed as JSON, until `[DONE]`. */
export async function* sse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
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
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "[DONE]") return;
				if (data) yield JSON.parse(data) as Record<string, unknown>;
			}
		}
		const rest = buffer.trim();
		if (rest.startsWith("data:") && rest.slice(5).trim() !== "[DONE]") yield JSON.parse(rest.slice(5).trim()) as Record<string, unknown>;
	} finally {
		reader.releaseLock();
	}
}

/** Tool calls arrive in pieces (`delta.tool_calls[i].function.arguments` a few characters at a time); this puts them together. */
export class ToolCallAccumulator {
	private parts = new Map<number, { id?: string; name: string; args: string }>();

	add(deltas: unknown): void {
		if (!Array.isArray(deltas)) return;
		for (const [pos, raw] of deltas.entries()) {
			const d = raw as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
			const i = typeof d.index === "number" ? d.index : pos;
			const cur = this.parts.get(i) ?? { name: "", args: "" };
			if (d.id) cur.id = d.id;
			if (d.function?.name) cur.name += d.function.name;
			if (typeof d.function?.arguments === "string") cur.args += d.function.arguments;
			this.parts.set(i, cur);
		}
	}

	calls(): ToolCall[] {
		return Array.from(this.parts.entries())
			.sort(([a], [b]) => a - b)
			.filter(([, p]) => p.name)
			.map(([i, p]) => {
				let args: unknown = {};
				try {
					args = p.args.trim() ? JSON.parse(p.args) : {};
				} catch {
					args = { [INVALID_ARGUMENTS]: p.args.slice(0, 300) };
				}
				if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
				return { id: p.id ?? `call_${i}`, function: { name: p.name, arguments: args as Record<string, unknown> } };
			});
	}
}

/** The message of a non-streamed completion. */
export function fromOpenAIChoice(json: Record<string, unknown>): ChatMessage {
	const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as { message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown } } | undefined;
	const m = choice?.message ?? {};
	const out: ChatMessage = { role: "assistant", content: typeof m.content === "string" ? m.content : "" };
	if (typeof m.reasoning_content === "string" && m.reasoning_content) out.thinking = m.reasoning_content;
	const acc = new ToolCallAccumulator();
	acc.add(m.tool_calls);
	const calls = acc.calls();
	if (calls.length) out.tool_calls = calls;
	return out;
}

/** Ollama-style options mapped to the OpenAI request fields servers accept. */
export function openAIOptions(options: { temperature?: number; top_p?: number; presence_penalty?: number; num_predict?: number; top_k?: number } = {}): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (options.temperature !== undefined) out.temperature = options.temperature;
	if (options.top_p !== undefined) out.top_p = options.top_p;
	if (options.presence_penalty !== undefined) out.presence_penalty = options.presence_penalty;
	if (options.num_predict !== undefined) out.max_tokens = options.num_predict;
	// top_k is not in the OpenAI API, but llama.cpp, LM Studio and vLLM all accept it.
	if (options.top_k !== undefined) out.top_k = options.top_k;
	return out;
}

/**
 * Separates reasoning a server sends inline, as `<think>…</think>` at the start of the reply,
 * from the reply itself. llama.cpp's server and vLLM send reasoning in its own field; LM Studio
 * and others leave the tags in the text unless told otherwise, and the chat would then show the
 * model's scratch work as its answer, and feed it back to the model on the next step. Fed the
 * stream piece by piece; a tag cut in two by a chunk boundary is handled.
 */
export class ThinkSplitter {
	private state: "start" | "thinking" | "content" = "start";
	private held = "";

	feed(piece: string): { content: string; thinking: string } {
		let text = this.held + piece;
		this.held = "";
		let content = "";
		let thinking = "";
		while (text) {
			if (this.state === "content") {
				content += text;
				break;
			}
			if (this.state === "start") {
				const lead = text.replace(/^\s+/, "");
				if (lead.startsWith("<think>")) {
					this.state = "thinking";
					text = lead.slice("<think>".length);
					continue;
				}
				// Not enough yet to know whether the reply opens with the tag.
				if (lead.length < "<think>".length && "<think>".startsWith(lead)) {
					this.held = text;
					break;
				}
				this.state = "content";
				continue;
			}
			const end = text.indexOf("</think>");
			if (end >= 0) {
				thinking += text.slice(0, end);
				this.state = "content";
				text = text.slice(end + "</think>".length).replace(/^\s+/, "");
				continue;
			}
			// Keep back a tail that could be the start of the closing tag.
			let keep = 0;
			for (let k = Math.min(text.length, "</think>".length - 1); k > 0; k--) {
				if ("</think>".startsWith(text.slice(-k))) {
					keep = k;
					break;
				}
			}
			thinking += text.slice(0, text.length - keep);
			this.held = text.slice(text.length - keep);
			break;
		}
		return { content, thinking };
	}

	/** What was held back when the stream ended (an unfinished tag is text after all). */
	flush(): { content: string; thinking: string } {
		const rest = this.held;
		this.held = "";
		return this.state === "thinking" ? { content: "", thinking: rest } : { content: rest, thinking: "" };
	}
}

/**
 * The context window an OpenAI-compatible server has `model` loaded with, when its model list
 * says: llama.cpp's server reports it as `meta.n_ctx` (checked against a real server), LM Studio's
 * own list (`/api/v0/models`) as `loaded_context_length` (from its documentation, not tried).
 * Undefined when the server does not say, which is most of them.
 */
export function modelContext(json: Record<string, unknown>, model: string): number | undefined {
	const rows = Array.isArray(json.data) ? (json.data as Record<string, unknown>[]) : [];
	const wanted = model.trim().toLowerCase();
	const named = (r: Record<string, unknown>) => {
		const names: unknown[] = Array.isArray(r.aliases) ? [r.id, ...(r.aliases as unknown[])] : [r.id];
		return names.some((x) => typeof x === "string" && x.toLowerCase() === wanted);
	};
	const row = rows.find(named) ?? (rows.length === 1 ? rows[0] : undefined);
	if (!row) return undefined;
	const meta = (row.meta ?? {}) as Record<string, unknown>;
	const n = [meta.n_ctx, row.loaded_context_length].find((v) => typeof v === "number" && v > 0);
	return typeof n === "number" ? n : undefined;
}

/**
 * The context size to budget a prompt for: the plugin's setting, or the size the server says it
 * has the model loaded with when that is smaller. A server that does not say (`reported`
 * undefined) leaves the setting as it is.
 */
export function effectiveContext(setting: number, reported: number | undefined): number {
	return reported !== undefined && reported > 0 && reported < setting ? reported : setting;
}

/** `/v1/models` → model ids. */
export function modelIds(json: Record<string, unknown>): string[] {
	return Array.isArray(json.data) ? (json.data as { id?: unknown }[]).map((m) => (typeof m.id === "string" ? m.id : "")).filter(Boolean) : [];
}

/** `/v1/embeddings` → vectors in input order. */
export function embeddingVectors(json: Record<string, unknown>, count: number): number[][] | null {
	if (!Array.isArray(json.data)) return null;
	const rows = (json.data as { index?: number; embedding?: unknown }[]).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	const vecs = rows.map((r) => r.embedding).filter((e): e is number[] => Array.isArray(e));
	return vecs.length === count ? vecs : null;
}
