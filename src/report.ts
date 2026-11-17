import { formatLogLine, type LogEntry } from "./log";

/**
 * "Report a problem": a GitHub issue body the user reads and edits before anything leaves the
 * machine. What goes in: versions, platform, model names, settings that are not secret, index
 * stats and the recent log. What never goes in: keys and tokens, URL query strings, the user's
 * home and vault paths, and note contents or chat text (unless the user ticks "include the last
 * chat"). Pure: every function here is tested.
 */

export const REPO = "TonyPeonio/obsidian-local-vault-agent";
/** Above this many characters of URL the issue is opened with a short body and the report goes to the clipboard. */
export const MAX_URL_CHARS = 7000;

/** Setting keys that are secrets or personal text, never included. */
const SECRET_KEYS = /key|token|secret|password|auth|bearer/i;
const PERSONAL_KEYS = new Set(["extraSystemPrompt", "jobRuns"]);

export interface ReportPaths {
	/** Absolute path of the vault folder, replaced by `<vault>`. */
	vault?: string;
	/** The user's home folder, replaced by `~`. */
	home?: string;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Text with secrets and personal paths taken out: query strings and credentials in URLs, bearer
 * tokens and API-key-looking strings, e-mail addresses, the vault path → `<vault>`, the home
 * folder → `~`, and any other user folder under /Users, /home or C:\Users → `~`.
 */
export function redact(text: string, paths: ReportPaths = {}): string {
	let out = text;
	// URLs: keep scheme, host, port and path; drop user:pass@, query and fragment.
	out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]+@)?([^\s/?#]+)([^\s?#]*)(?:\?[^\s#]*)?(?:#\S*)?/gi, "$1$2$3");
	out = out.replace(/\b(Bearer|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>");
	out = out.replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|hf|xox[abp])[-_][A-Za-z0-9_-]{10,}\b/g, "<redacted-key>");
	out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email>");
	const swap = (from: string | undefined, to: string) => {
		if (!from || from.length < 3) return;
		const variants = new Set([from, from.replace(/\\/g, "/"), from.replace(/\//g, "\\")]);
		for (const v of variants) out = out.replace(new RegExp(escapeRegExp(v.replace(/[\\/]+$/, "")), "gi"), to);
	};
	swap(paths.vault, "<vault>");
	swap(paths.home, "~");
	out = out.replace(/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`]+/gi, "~").replace(/\/(?:Users|home)\/[^/\s"'`]+/g, "~");
	return out;
}

/** Settings safe to show: secrets dropped, personal free text reduced to whether it is set, URLs redacted. */
export function safeSettings(settings: Record<string, unknown>, paths: ReportPaths = {}): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(settings)) {
		if (SECRET_KEYS.test(k)) {
			out[k] = typeof v === "string" && v ? "(set, not shown)" : "(empty)";
			continue;
		}
		if (PERSONAL_KEYS.has(k)) {
			out[k] = typeof v === "string" ? (v.trim() ? `(${v.length} characters, not shown)` : "(empty)") : "(not shown)";
			continue;
		}
		out[k] = typeof v === "string" ? redact(v, paths) : Array.isArray(v) ? (v as unknown[]).map((x) => (typeof x === "string" ? redact(x, paths) : x)) : v;
	}
	return out;
}

export interface ReportInfo {
	pluginVersion: string;
	obsidianVersion: string;
	/** "Windows", "macOS 14", "Android", … */
	platform: string;
	mobile: boolean;
	provider: string;
	serverVersion: string | null;
	chatModel: string;
	embeddingModel: string;
	visionModel: string;
	/** Installed models on the server, or null when it could not be reached. */
	installedModels: string[] | null;
	notes: number;
	index: string;
	otherPlugins: string[];
	settings: Record<string, unknown>;
	log: LogEntry[];
}

/** The last chat as plain text (user and assistant turns, tool calls by name and result size). */
export function chatTranscript(messages: { role: string; content: string; tool_name?: string; tool_calls?: { function: { name: string } }[] }[], max = 6000): string {
	const lines: string[] = [];
	for (const m of messages) {
		if (m.role === "user") lines.push(`**User:** ${m.content.split("\n\n(The user attached")[0]}`);
		else if (m.role === "assistant") {
			if (m.content.trim()) lines.push(`**Assistant:** ${m.content}`);
			for (const c of m.tool_calls ?? []) lines.push(`- tool call: ${c.function.name}`);
		} else if (m.role === "tool") lines.push(`- ${m.tool_name ?? "tool"} result: ${m.content.length} characters${/^Error|^Not executed/.test(m.content) ? ` — ${m.content.slice(0, 200)}` : ""}`);
	}
	const text = lines.join("\n");
	return text.length > max ? `…${text.slice(-max)}` : text;
}

/** The issue body: what the user wrote, then the environment, settings and log, all redacted. */
export function buildReport(info: ReportInfo, description: string, opts: { paths?: ReportPaths; chat?: string } = {}): string {
	const p = opts.paths ?? {};
	const settings = safeSettings(info.settings, p);
	const body = [
		"### What happened",
		"",
		description.trim() || "<!-- What did you do, what did you expect, what happened instead? -->",
		"",
		"### Environment",
		"",
		`- Local Vault Agent ${info.pluginVersion}, Obsidian ${info.obsidianVersion}, ${info.platform}${info.mobile ? " (mobile)" : ""}`,
		`- Provider: ${info.provider}${info.serverVersion ? ` ${info.serverVersion}` : " (not reachable)"}`,
		`- Chat model: ${info.chatModel} · embedding: ${info.embeddingModel} · vision: ${info.visionModel || "(chat model if it can see)"}`,
		`- Installed models: ${info.installedModels ? info.installedModels.join(", ") || "(none)" : "(server not reachable)"}`,
		`- Vault: ${info.notes} notes · index: ${info.index}`,
		`- Other enabled plugins: ${info.otherPlugins.length ? info.otherPlugins.join(", ") : "(none)"}`,
		"",
		"<details><summary>Settings (keys and personal text left out)</summary>",
		"",
		"```json",
		JSON.stringify(settings, null, 1),
		"```",
		"</details>",
		"",
		"<details><summary>Recent log</summary>",
		"",
		"```",
		info.log.length ? info.log.map(formatLogLine).join("\n") : "(empty)",
		"```",
		"</details>",
	];
	if (opts.chat?.trim()) body.push("", "<details><summary>Last chat (included by the user)</summary>", "", opts.chat.trim(), "", "</details>");
	return redact(body.join("\n"), p);
}

/** A short issue title from the description (or the last error). */
export function reportTitle(description: string, lastError?: string): string {
	const first = description.trim().split("\n")[0]?.trim() || lastError?.trim() || "Problem report";
	return first.length > 80 ? first.slice(0, 77) + "…" : first;
}

/**
 * The URL that opens a new issue with the title and body filled in. When it would be too long for
 * a browser to carry, the body becomes a request to paste the report (which the caller copies to
 * the clipboard), and `copyFirst` is true.
 */
export function issueUrl(title: string, body: string, repo = REPO): { url: string; copyFirst: boolean } {
	const base = `https://github.com/${repo}/issues/new`;
	const full = `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
	if (full.length <= MAX_URL_CHARS) return { url: full, copyFirst: false };
	const short = "<!-- The report was copied to your clipboard: paste it here (Ctrl/Cmd+V), then review it before submitting. -->\n\n";
	return { url: `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(short)}`, copyFirst: true };
}

/** The GitHub Discussions URL for the one-question survey (opens a new discussion with the answer filled in). */
export function surveyUrl(answer: string, version: string, repo = REPO): string {
	const title = `Feedback: ${answer}`;
	const body = `How is Local Vault Agent working for me? **${answer}**\n\n(Version ${version}.) <!-- Anything to add: what you use it for, what is missing, what went wrong. -->`;
	return `https://github.com/${repo}/discussions/new?category=general&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
