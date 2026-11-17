import { describe, expect, it } from "vitest";
import { englishKeys, hasKey, answerLanguageLine, locale, setLocale, t } from "../src/i18n";
import { RingLog, formatLogLine } from "../src/log";
import { MAX_URL_CHARS, buildReport, chatTranscript, issueUrl, redact, reportTitle, safeSettings, surveyUrl, withChatSection, withDescription, type ReportInfo } from "../src/report";
import { SAMPLE_FOLDER, SAMPLE_QUESTIONS, sampleNotes } from "../src/sample";
import { RECOMMENDED, evaluateSetup, formatProgress, guessTier, setupComplete, type SetupInput } from "../src/setup";

describe("redact", () => {
	it("drops URL credentials, query strings and fragments but keeps host and path", () => {
		expect(redact("GET http://user:pw@192.168.1.5:11434/api/tags?key=abc#x failed")).toBe("GET http://192.168.1.5:11434/api/tags failed");
	});

	it("removes tokens, API keys and e-mail addresses", () => {
		expect(redact("Authorization: Bearer abcdef1234567890")).toBe("Authorization: Bearer <redacted>");
		expect(redact("key sk-proj-AbCdEf1234567890xyz and ghp_1234567890abcdefXYZ")).toBe("key <redacted-key> and <redacted-key>");
		expect(redact("mail me at someone.name@example.org")).toBe("mail me at <email>");
	});

	it("replaces the vault and home paths, in either slash style, and any other user folder", () => {
		const paths = { vault: "C:\\Users\\alex\\Documents\\My Vault", home: "C:\\Users\\alex" };
		expect(redact("Error: C:\\Users\\alex\\Documents\\My Vault\\Notes\\a.md not found", paths)).toBe("Error: <vault>\\Notes\\a.md not found");
		expect(redact("at C:/Users/alex/Documents/My Vault/.obsidian/x.json", paths)).toBe("at <vault>/.obsidian/x.json");
		expect(redact("cache C:\\Users\\alex\\AppData\\x", paths)).toBe("cache ~\\AppData\\x");
		expect(redact("/Users/sam/notes and /home/kim/x")).toBe("~/notes and ~/x");
	});

	it("catches JSON-escaped (doubled-backslash) paths, with or without the known folders", () => {
		const logged = '500: {"error":{"message":"failed to load C:\\\\Users\\\\tony\\\\models\\\\x.gguf"}}';
		expect(redact(logged, { home: "C:\\Users\\tony" })).toBe('500: {"error":{"message":"failed to load ~\\\\models\\\\x.gguf"}}');
		expect(redact(logged)).not.toContain("tony");
		expect(redact("open D:\\\\Notes\\\\My Vault\\\\a.md", { vault: "D:\\Notes\\My Vault" })).toBe("open <vault>\\\\a.md");
		expect(redact("open /Users/sam//vault/a.md", { vault: "/Users/sam/vault/" })).toBe("open <vault>/a.md");
	});

	it("replaces a home folder with a space in its name when the vault is elsewhere", () => {
		expect(redact("open C:\\Users\\John Smith\\.ollama\\models\\x", { vault: "D:\\Notes", home: "C:\\Users\\John Smith" })).toBe("open ~\\.ollama\\models\\x");
	});
});

describe("safeSettings", () => {
	it("hides secrets and personal text, keeps the rest", () => {
		const out = safeSettings({ openaiKey: "sk-123", apiToken: "", extraSystemPrompt: "I study at Example U", model: "qwen3.5:9b", ollamaUrl: "http://x:1/?t=1", excludedFolders: ["C:\\Users\\a\\b"], numCtx: 32768 });
		expect(out).toEqual({ openaiKey: "(set, not shown)", apiToken: "(empty)", extraSystemPrompt: "(20 characters, not shown)", model: "qwen3.5:9b", ollamaUrl: "http://x:1/", excludedFolders: "(1 entries, not shown)", numCtx: 32768 });
	});

	it("never publishes folder, note or heading names from settings", () => {
		const settings = { excludedFolders: ["Journal/Therapy", "Clients/Acme lawsuit"], conceptFolders: ["Diagnoses"], conventionsNote: "Private/RULES.md", dailyTopicsFolder: "Moods", dailyInboxHeading: "Confessions", quizReviewFolder: "Resits", digestFolder: "Clients/Acme" };
		expect(safeSettings(settings)).toEqual({ excludedFolders: "(2 entries, not shown)", conceptFolders: "(1 entries, not shown)", conventionsNote: "(16 characters, not shown)", dailyTopicsFolder: "(5 characters, not shown)", dailyInboxHeading: "(11 characters, not shown)", quizReviewFolder: "(6 characters, not shown)", digestFolder: "(12 characters, not shown)" });
		const body = buildReport({ ...INFO, settings }, "x");
		for (const name of ["Therapy", "Acme", "Diagnoses", "RULES", "Moods", "Confessions", "Resits"]) expect(body).not.toContain(name);
	});
});

const INFO: ReportInfo = {
	pluginVersion: "0.8.0",
	obsidianVersion: "1.13.2",
	platform: "Windows",
	mobile: false,
	provider: "Ollama",
	serverVersion: "0.40.16",
	chatModel: "qwen3.5:9b",
	embeddingModel: "nomic-embed-text",
	visionModel: "",
	installedModels: ["qwen3.5:9b", "nomic-embed-text:latest"],
	notes: 339,
	index: "334 notes, 1088 chunks",
	otherPlugins: ["dataview"],
	settings: { model: "qwen3.5:9b", openaiKey: "sk-secretsecretsecret" },
	log: [{ time: Date.UTC(2026, 10, 17, 12, 0, 5), level: "error", message: "Cannot reach http://localhost:11434/api/tags?x=1 from C:\\Users\\alex\\Vault" }],
};

describe("buildReport", () => {
	it("contains versions, models, index, settings and log, redacted, and no chat unless asked", () => {
		const body = buildReport(INFO, "The chat froze.", { paths: { vault: "C:\\Users\\alex\\Vault", home: "C:\\Users\\alex" } });
		expect(body).toMatch(/^### What happened\n\nThe chat froze\./);
		expect(body).toContain("- Local Vault Agent 0.8.0, Obsidian 1.13.2, Windows");
		expect(body).toContain("- Installed models: qwen3.5:9b, nomic-embed-text:latest");
		expect(body).toContain("index: 334 notes, 1088 chunks");
		expect(body).toContain('"openaiKey": "(set, not shown)"');
		expect(body).not.toContain("sk-secret");
		expect(body).toContain("12:00:05 ERROR Cannot reach http://localhost:11434/api/tags from <vault>");
		expect(body).not.toContain("Last chat");
	});

	it("adds the last chat only when included", () => {
		const chat = chatTranscript([
			{ role: "user", content: "What about X?\n\n(The user attached the following note…" },
			{ role: "assistant", content: "", tool_calls: [{ function: { name: "read_note" } }] },
			{ role: "tool", content: "Error: No note found", tool_name: "read_note" },
			{ role: "assistant", content: "Nothing on X." },
		]);
		expect(chat).toBe("**User:** What about X?\n- tool call: read_note\n- read_note result: 20 characters — Error: No note found\n**Assistant:** Nothing on X.");
		expect(buildReport(INFO, "", { chat })).toContain("<summary>Last chat (included by the user)</summary>");
		expect(buildReport(INFO, "")).toContain("<!-- What did you do");
	});

	it("titles from the description or the last error", () => {
		expect(reportTitle("Freezes on long notes\nmore", "x")).toBe("Freezes on long notes");
		expect(reportTitle("", "Cannot reach Ollama")).toBe("Cannot reach Ollama");
		expect(reportTitle("", undefined)).toBe("Problem report");
		expect(reportTitle("a".repeat(100)).length).toBe(78);
	});

	it("redacts the title, from either source, before cutting it", () => {
		const title = reportTitle("Local Vault Agent cannot reach Ollama at https://tony:hunter2@ollama.example.net/x?k=1 (mail a.b@example.org)");
		expect(title).toBe("Local Vault Agent cannot reach Ollama at https://ollama.example.net/x (mail <…");
		const fromError = reportTitle("  ", "Undo failed: ENOENT, open 'C:\\Users\\tony\\Vault\\Notes\\x.md'", { vault: "C:\\Users\\tony\\Vault" });
		expect(fromError).toBe("Undo failed: ENOENT, open '<vault>\\Notes\\x.md'");
		// A URL that the 80-character cut would split inside user:pass@ is redacted whole first.
		expect(reportTitle(`${"x".repeat(60)} https://tony:hunter2hunter2hunter2@host.example/`)).not.toMatch(/tony|hunter2/);
		expect(reportTitle("", "open D:\\Vault\\a.md", { vault: "D:\\Vault" })).toBe("open <vault>\\a.md");
	});

	it("keeps hand edits when the description changes, replacing only What happened", () => {
		const paths = { vault: "C:\\Users\\alex\\Vault", home: "C:\\Users\\alex" };
		const edited = buildReport(INFO, "First try.", { paths }).replace("- Other enabled plugins: dataview\n", "").replace(/12:00:05 ERROR[^\n]*/, "(log removed)");
		const next = withDescription(edited, buildReport(INFO, "It froze at C:\\Users\\alex\\Vault\\a.md\n\nTwice.", { paths }));
		expect(next).toMatch(/^### What happened\n\nIt froze at <vault>\\a\.md\n\nTwice\.\n\n### Environment\n/);
		expect(next).not.toContain("dataview");
		expect(next).toContain("(log removed)");
		expect(next).not.toContain("12:00:05");
		expect(withDescription(edited, buildReport(INFO, "", { paths }))).toContain("### What happened\n\n<!-- What did you do");
		expect(withDescription("only my own words", buildReport(INFO, "x"))).toBeNull();
	});

	it("adds and removes the chat section without rebuilding a hand-edited report", () => {
		const without = buildReport(INFO, "x");
		const withChat = buildReport(INFO, "x", { chat: "**User:** secret question" });
		const edited = without.replace("- Other enabled plugins: dataview\n", "");
		const added = withChatSection(edited, without, withChat, true)!;
		expect(added).not.toContain("dataview");
		expect(added.endsWith("<details><summary>Last chat (included by the user)</summary>\n\n**User:** secret question\n\n</details>")).toBe(true);
		expect(withChatSection(added, without, withChat, true)).toBe(added);
		expect(withChatSection(added, without, withChat, false)).toBe(edited);
		// The chat itself was edited: the whole block still goes.
		expect(withChatSection(added.replace("secret question", "question"), without, withChat, false)).toBe(edited);
		expect(withChatSection(edited, without, withChat, false)).toBe(edited);
		// No chat to include: nothing changes.
		expect(withChatSection(edited, without, without, true)).toBe(edited);
	});
});

describe("issueUrl and surveyUrl", () => {
	it("puts a short report in the URL, and a long one on the clipboard", () => {
		const short = issueUrl("T", "body text");
		expect(short.copyFirst).toBe(false);
		expect(short.url).toBe("https://github.com/TonyPeonio/obsidian-local-vault-agent/issues/new?title=T&body=body%20text");
		const long = issueUrl("T", "x".repeat(MAX_URL_CHARS));
		expect(long.copyFirst).toBe(true);
		expect(long.url.length).toBeLessThan(MAX_URL_CHARS);
		expect(decodeURIComponent(long.url)).toContain("copied to your clipboard");
	});

	it("does not throw on half an emoji left by a cut", () => {
		const title = reportTitle("a".repeat(76) + "\u{1F600}" + "b".repeat(10));
		expect(title.charCodeAt(76)).toBe(0xd83d);
		const { url } = issueUrl(title, "x\uD83D y\uDE00\uDE00 ok \u{1F600}");
		expect(decodeURIComponent(url.split("?")[1])).toBe(`title=${"a".repeat(76)}…&body=x y ok \u{1F600}`);
		expect(issueUrl("t\uDE00", "\uD83D" + "x".repeat(MAX_URL_CHARS)).url).toContain("title=t&body=");
	});

	it("opens a prefilled discussion", () => {
		expect(surveyUrl("It works well", "0.8.0")).toMatch(/^https:\/\/github\.com\/TonyPeonio\/obsidian-local-vault-agent\/discussions\/new\?category=general&title=Feedback%3A%20It%20works%20well&body=/);
	});
});

describe("RingLog", () => {
	it("keeps the last entries, flattened and capped", () => {
		let now = 0;
		const l = new RingLog(3, () => (now += 1000));
		l.info("a");
		l.error(new TypeError("b\n  c"));
		l.warn("x".repeat(600));
		l.info("d");
		expect(l.size).toBe(3);
		expect(l.tail(2).map((e) => e.message.length)).toEqual([500, 1]);
		expect(l.lastError()?.message).toBe("TypeError: b c");
		expect(formatLogLine(l.tail(1)[0])).toBe("00:00:04 INFO  d");
	});
});

describe("i18n", () => {
	it("fills placeholders, falls back to English and knows its keys", () => {
		expect(t("view.status.index", { notes: 3, chunks: 9 })).toBe("Index: 3 notes, 9 chunks");
		expect(t("set.lc.desc", { url: "u" })).toContain("uses u with {model}");
		expect(setLocale("de-DE")).toBe("en");
		expect(locale()).toBe("en");
		expect(hasKey("set.url.desc")).toBe(true);
		expect(hasKey("set.showThinking.desc")).toBe(false);
		expect(englishKeys().length).toBeGreaterThan(150);
	});

	it("tells the model which language to answer in", () => {
		expect(answerLanguageLine("")).toMatch(/language the user writes in/);
		expect(answerLanguageLine(" Deutsch ")).toMatch(/^Always write your answers in Deutsch/);
	});
});

const BASE: SetupInput = {
	provider: "ollama",
	models: [
		{ name: "qwen3.5:9b", size: 1, capabilities: ["completion", "tools"] },
		{ name: "nomic-embed-text:latest", size: 1, capabilities: ["embedding"] },
	],
	chatModel: "qwen3.5:9b",
	embeddingModel: "nomic-embed-text",
	semanticSearch: true,
	index: { indexedFiles: 10, building: false, pending: 0 },
	notes: 10,
	tier: "12",
};

describe("setup checklist", () => {
	it("is complete with a tool model, an embedding model and an index", () => {
		const steps = evaluateSetup(BASE);
		expect(steps.map((s) => s.state)).toEqual(["ok", "ok", "ok", "ok"]);
		expect(setupComplete(steps)).toBe(true);
	});

	it("offers to download what is missing, for the machine's tier", () => {
		const steps = evaluateSetup({ ...BASE, models: [], chatModel: "qwen3.5:9b", tier: "8" });
		expect(steps[1]).toMatchObject({ state: "missing", fix: { kind: "pull", model: RECOMMENDED["8"] } });
		expect(steps[2]).toMatchObject({ state: "missing", fix: { kind: "pull", model: "nomic-embed-text" } });
		expect(setupComplete(steps)).toBe(false);
	});

	it("says which role a download is for, whatever the model is called", () => {
		const steps = evaluateSetup({ ...BASE, models: [], embeddingModel: "bge-m3", tier: "8" });
		expect(steps[1].fix).toEqual({ kind: "pull", model: RECOMMENDED["8"], role: "chat" });
		expect(steps[2].fix).toEqual({ kind: "pull", model: "bge-m3", role: "embed" });
		const noTools = evaluateSetup({ ...BASE, models: [{ name: "gemma:2b", size: 1, capabilities: ["completion"] }], chatModel: "gemma:2b" });
		expect(noTools[1].fix).toEqual({ kind: "pull", model: RECOMMENDED["12"], role: "chat" });
	});

	it("suggests an installed tool model when the chosen one cannot call tools", () => {
		const steps = evaluateSetup({ ...BASE, models: [{ name: "gemma:2b", size: 1, capabilities: ["completion"] }, { name: "llama3.1:8b", size: 1, capabilities: ["completion", "tools"] }], chatModel: "gemma:2b" });
		expect(steps[1]).toMatchObject({ state: "missing", fix: { kind: "use", model: "llama3.1:8b", role: "chat" } });
	});

	it("explains an unreachable server and an empty index; never pulls from an OpenAI-compatible server", () => {
		const down = evaluateSetup({ ...BASE, models: null, serverError: "ECONNREFUSED" });
		expect(down[0]).toMatchObject({ state: "missing", fix: { kind: "settings" } });
		expect(down[0].detail).toMatch(/ECONNREFUSED/);
		expect(down.slice(1).every((s) => s.state === "unknown")).toBe(true);
		expect(evaluateSetup({ ...BASE, index: { indexedFiles: 0, building: false, pending: 0 } })[3]).toMatchObject({ state: "missing", fix: { kind: "index" } });
		const lm = evaluateSetup({ ...BASE, provider: "openai", models: [{ name: "qwen2.5-7b-instruct", size: 0 }], chatModel: "missing" });
		expect(lm[1].fix).toEqual({ kind: "use", model: "qwen2.5-7b-instruct", role: "chat" });
	});

	it("guesses a tier and formats progress", () => {
		expect(guessTier(undefined)).toBe("12");
		expect(guessTier(4)).toBe("8");
		expect(formatProgress(0.426, "pulling")).toBe("43%");
		expect(formatProgress(null, "pulling manifest")).toBe("pulling manifest");
	});
});

describe("sample notes", () => {
	it("are a linked folder whose notes answer the sample questions", () => {
		const notes = sampleNotes();
		expect(notes.every((n) => n.path.startsWith(`${SAMPLE_FOLDER}/`) && n.path.endsWith(".md"))).toBe(true);
		const all = notes.map((n) => n.content).join("\n");
		expect(SAMPLE_QUESTIONS).toHaveLength(3);
		expect(all).toContain("switched from AA NiMH to 18650 lithium cells");
		expect(all).toMatch(/\*\*\[12:40\]\*\* The Calvin cycle/);
		expect(all).toContain("Suggested a protection board");
		// Every wikilink points at a sample note.
		const paths = new Set(notes.map((n) => n.path.replace(/\.md$/, "")));
		for (const m of all.matchAll(/\[\[([^\]|]+)/g)) expect(paths.has(m[1])).toBe(true);
	});
});
