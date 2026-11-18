/**
 * UI strings. English is complete; another language is a partial dictionary of the same keys
 * (missing keys fall back to English). The locale follows Obsidian's language setting. Model
 * prompts are not here on purpose: they are tuned and benchmarked in English, and the answer
 * language is a separate setting (see `answerLanguageLine`).
 */

const en = {
	// Settings: headings
	"set.h.server": "Model server",
	"set.h.search": "Search",
	"set.h.agent": "Agent",
	"set.h.study": "Study",
	"set.h.schedule": "Scheduled jobs",
	"set.h.help": "Help and feedback",

	// Settings: server
	"set.provider.name": "Provider",
	"set.provider.desc": "Ollama (the default, what the benchmark measures), or any server with an OpenAI-compatible API on your machine: LM Studio, llama.cpp server, Jan, vLLM.",
	"set.provider.ollama": "Ollama",
	"set.provider.openai": "OpenAI-compatible (LM Studio, llama.cpp, Jan, vLLM)",
	"set.url.name": "Ollama URL",
	"set.url.desc": "Where Ollama is listening. Use a LAN address on mobile.",
	"set.oaUrl.name": "Server URL",
	"set.oaUrl.desc": "Base URL of the OpenAI-compatible API, ending in /v1. LM Studio: http://localhost:1234/v1 · llama.cpp: http://localhost:8080/v1 · Jan: http://localhost:1337/v1 · vLLM: http://localhost:8000/v1.",
	"set.oaKey.name": "API key",
	"set.oaKey.desc": "Only if your local server asks for one. Stored in the plugin's settings, never sent anywhere but that server, and never included in a problem report.",
	"set.test.button": "Test connection and speed",
	"set.lc.name": "Use Lecture Companion's Ollama settings",
	"set.lc.desc": "Lecture Companion is installed and uses {url} with {model}. Copy them here so both plugins share one Ollama and one model in memory.",
	"set.model.name": "Chat model",
	"set.model.desc": "Must support tool calling. Recommended: qwen3.5:9b (12 GB GPUs), qwen3.5:4b (8 GB), qwen3.5:35b-a3b (24 GB).",
	"set.model.placeholder": "or type a model name",
	"set.ctx.name": "Context window (num_ctx)",
	"set.ctx.desc": "Tokens the model can see at once. 32768 is the default and the benchmark's setting; 16384 on an 8 GB card. Larger is not faster or more accurate: the conversation is capped at the 32k budget regardless, and the KV cache grows with the window. (Ollama only; other servers set this when loading the model.)",
	"set.temp.name": "Temperature",
	"set.temp.desc": "0.6 is the default. Lower looks more precise but near-greedy decoding makes small models repeat themselves; Qwen's own guidance is 0.6–0.7.",
	"set.think.name": "Thinking mode",
	"set.think.desc": "For models that support reasoning (Qwen3, DeepSeek-R1). 'Off' (the default) answered as accurately as thinking in the benchmark and two to three times faster. 'Auto' uses the model default.",
	"set.think.auto": "Auto",
	"set.think.on": "On",
	"set.think.off": "Off",
	"set.showThinking.name": "Show thinking in chat",
	"set.keepAlive.name": "Keep model loaded",
	"set.keepAlive.desc": "How long Ollama keeps the model in memory after a request (e.g. 10m, 1h, -1 for forever).",
	"set.vision.name": "Vision model",
	"set.vision.desc": "Reads images notes embed and scanned PDF pages (the read_image tool), e.g. qwen2.5vl:7b. Empty: the chat model, when it can see (qwen3.5 can). Without one the agent is simply not offered the tool.",
	"set.vision.placeholder": "(the chat model)",
	"set.vision.check": "Check",
	"set.lang.name": "Answer language",
	"set.lang.desc": "Empty: answer in the language of each question. Or name a language (e.g. Deutsch, Español, 日本語) to always answer in it.",
	"set.lang.placeholder": "(the question's language)",

	// Settings: search
	"set.semantic.name": "Semantic search",
	"set.semantic.desc": "Embed your notes with a local model so search understands meaning, not just keywords. Keyword search always works as a fallback.",
	"set.embed.name": "Embedding model",
	"set.embed.desc": "Changing this rebuilds the index. nomic-embed-text is small and good.",
	"set.index.name": "Index",
	"set.index.building": "Indexing… {done} notes done, {pending} pending",
	"set.index.error": "Error: {error}",
	"set.index.ready": "{notes} notes indexed ({chunks} chunks)",
	"set.index.update": "Update",
	"set.index.rebuild": "Rebuild",
	"set.excluded.name": "Excluded folders",
	"set.excluded.desc": "One folder per line. These are never searched, indexed or edited by the agent.",
	"set.gists.name": "Note gists",
	"set.gists.desc": "Write a one-sentence gist of every note with the chat model (in the background, paused while you chat) for the vault outline the agent sees. Off by default: the benchmark scored the same without it, and on a modest GPU it is an hour for a large vault.",
	"set.gists.rebuild": "Rebuild",

	// Settings: agent
	"set.autoApprove.name": "Auto-approve edits",
	"set.autoApprove.desc": "Skip the diff approval dialog and let the agent write to notes directly. Not recommended; you can also choose 'Approve all in this chat' in the diff dialog, which the chat shows while it is on.",
	"set.autoContinue.name": "Keep going when the model asks for permission",
	"set.autoContinue.desc": "Small models like to stop with 'Would you like me to proceed?'. When on, the agent answers yes for you (up to three times per message) so multi-note tasks run to the end. Every write still goes through approval.",
	"set.maxIter.name": "Max tool calls per message",
	"set.maxIter.desc": "Stops runaway loops. Multi-note clean-ups need 2–3 calls per note, so keep this generous.",
	"set.maxChars.name": "Max characters per tool result",
	"set.maxChars.desc": "Longer notes are paged. Lower this for small context windows.",
	"set.conventions.name": "Conventions note",
	"set.conventions.desc": "A note in your vault that is given to the agent on every message, like a CLAUDE.md: folder meanings, naming rules, things to never touch.",
	"set.conventions.button": "Create / open",
	"set.inbox.name": "Daily notes inbox heading",
	"set.inbox.desc": "For 'Process my daily notes': the section of each daily note where loose captures land, without the #.",
	"set.topics.name": "Topic notes folder",
	"set.topics.desc": "For 'Process my daily notes': where compiled topic notes are created. Empty means the vault root.",
	"set.citations.name": "Paragraph citations",
	"set.citations.desc": "Answers end with links to the exact paragraphs they used. 'Block ids' links by ^id; a paragraph without one gets an id added, shown as one diff per note for you to approve (rejecting falls back to the heading). 'Headings' never writes.",
	"set.citations.blocks": "Block ids (added on approval)",
	"set.citations.headings": "Headings only (no writes)",
	"set.citations.off": "Off",
	"set.extra.name": "Extra instructions",
	"set.extra.desc": "Appended to the system prompt. Tell the agent about your vault's conventions, preferred tone, note templates, etc.",

	// Settings: study
	"set.concepts.name": "Concept folders",
	"set.concepts.desc": "For 'Suggest concept links': folders whose notes are concept or topic notes, one per line. Notes tagged #concept or #topic, or with type: concept, count too.",
	"set.quizN.name": "Quiz questions",
	"set.quizN.desc": "How many questions 'Quiz me' asks by default.",
	"set.quizFolder.name": "Quiz review folder",
	"set.quizFolder.desc": "Missed questions go to 'Quiz review - <topic>' here, after you approve the diff.",
	"set.lcStatus.name": "Lecture Companion",
	"set.lcStatus.on": "Installed: the agent lists lectures and reads timestamped transcripts from it directly, quizzes draw on its courses, and the chat has a mic button that transcribes through its whisper server.",
	"set.lcStatus.off": "Not installed. With Lecture Companion the agent reads lectures and transcripts as structured data, quizzes know your courses, and the chat gets voice input.",

	// Settings: schedule
	"set.schedule.about": "Obsidian has no background service, so a job runs when Obsidian is open at or after its time. A job never writes: what it would change waits until you review it (a notice when you are back, and a badge in the status bar), as ordinary diffs.",
	"set.nightly.name": "Nightly: process my daily notes",
	"set.nightly.desc": "Compiles the last two days' daily inboxes into topic notes, as the command does, and queues the changes for your review.",
	"set.nightlyTime.name": "Nightly time",
	"set.nightlyTime.desc": "When the nightly job runs (local time).",
	"set.digest.name": "Weekly digest",
	"set.digest.desc": "A note summarising the notes you created or changed that week, with links, queued for your review.",
	"set.digestDay.name": "Digest day",
	"set.digestTime.name": "Digest time",
	"set.digestTime.desc": "When on that day the digest is written (local time).",
	"set.digestFolder.name": "Digest folder",
	"set.pending.name": "Waiting for review",
	"set.pending.some": "{n} change(s) from scheduled jobs.",
	"set.pending.none": "Nothing waiting.",
	"set.pending.button": "Review now",
	"day.0": "Sunday",
	"day.1": "Monday",
	"day.2": "Tuesday",
	"day.3": "Wednesday",
	"day.4": "Thursday",
	"day.5": "Friday",
	"day.6": "Saturday",

	// Settings: help
	"set.setup.name": "Setup checklist",
	"set.setup.desc": "Checks the model server, the chat and embedding models and the index, with a button to fix each.",
	"set.setup.button": "Open the checklist",
	"set.sample.name": "Try it on sample notes",
	"set.sample.desc": "Creates a small folder of sample notes and opens the chat with three questions to ask about them.",
	"set.sample.button": "Create sample notes",
	"set.report.name": "Report a problem",
	"set.report.desc": "Prepares a GitHub issue with your versions, settings (no keys, no paths, no notes) and recent errors. You review it; nothing is sent automatically.",
	"set.report.button": "Report a problem",

	// Commands
	"cmd.openChat": "Open chat",
	"cmd.askSelection": "Ask about the selected text",
	"cmd.reformat": "Reformat the current note",
	"cmd.summarize": "Summarize the current note",
	"cmd.editSelection": "Edit the selected text with an instruction",
	"cmd.daily": "Process my daily notes (compile inboxes into topic notes)",
	"cmd.garden": "Suggest vault improvements (report in the chat)",
	"cmd.undoLast": "Undo the agent's last change",
	"cmd.undoTurn": "Undo every change from the agent's last message",
	"cmd.history": "Show change history (undo any approved change)",
	"cmd.quiz": "Quiz me on a topic or course",
	"cmd.concepts": "Suggest concept links for this note",
	"cmd.review": "Review changes from scheduled jobs",
	"cmd.runNightly": "Run the nightly daily-notes job now (changes wait for review)",
	"cmd.runDigest": "Write this week's digest now (waits for review)",
	"cmd.stopJob": "Stop the running scheduled job",
	"cmd.gists": "Rebuild note gists",
	"cmd.index": "Rebuild semantic index",
	"cmd.report": "Report a problem",
	"cmd.setup": "Setup checklist",
	"cmd.sample": "Try it on sample notes",
	"ribbon.open": "Open Local Vault Agent",

	// Chat view
	"view.title": "Local Vault Agent",
	"view.newChat": "New chat",
	"view.copyChat": "Copy conversation as markdown",
	"view.refreshModels": "Refresh model list",
	"view.modelSelect": "Chat model",
	"view.messages": "Conversation",
	"view.input.placeholder": "Ask about your notes… (@ to attach a note, / for commands, Shift+Enter for a new line)",
	"view.input.label": "Message",
	"view.send": "Send",
	"view.stop": "Stop",
	"view.mic": "Dictate (Lecture Companion transcribes it)",
	"view.mic.stop": "Stop and transcribe",
	"view.mic.busy": "Transcribing…",
	"view.welcome": "Ask questions about your notes, compile topics, or ask for edits across many notes. Every change is shown as a diff before it is written and can be undone.",
	"view.welcome.hint": "@ attaches a note to your message · / lists commands · Shift+Enter for a new line",
	"view.welcome.sample": "New here? Try it on sample notes",
	"view.welcome.setup": "Setup checklist",
	"view.chip.written": "What have I written about …?",
	"view.chip.compile": "Compile everything about … into a new note",
	"view.chip.cleanup": "Clean up every note that …",
	"view.chip.reformat": "Reformat the current note",
	"view.copy": "Copy",
	"view.insert": "Insert at cursor",
	"view.undo": "Undo",
	"view.undone": "Undone",
	"view.restored": "Restored from the previous session.",
	"view.queue.hint": "Queued: sent when this reply is finished. Stop clears the queue.",
	"view.queue.hint.job": "Queued: sent when {job} has finished.",
	"view.queue.takeBack": "Take back into the message box",
	"view.jump": "Jump to latest",
	"view.jump.new": "Jump to latest: there is new text below",
	"view.tool.failed": "failed",
	"view.tool.stopped": "stopped",
	"view.stopped": "Stopped.",
	"view.quiz.stoppedGrading": "Stopped before the answer was graded. The question is still open: answer again, or type stop to end the quiz.",
	"view.autoContinued": "The model asked whether to continue — answered yes automatically.",
	"view.groundingNudge": "The reply cited notes that do not exist — sent it back to search the vault first.",
	"view.report": "Report this problem",
	"view.partial": "{n} change(s) were applied before the turn ended. Each was approved on its own and is complete; you can take them all back.",
	"view.partial.undo": "Undo these changes",
	"view.approveAll.chat": "Approve all is on: changes in this chat are written without a diff.",
	"view.approveAll.setting": "Auto-approve edits is on in settings: every change is written without a diff.",
	"view.approveAll.off": "Turn off",
	"view.approveAll.offNote": "Approve all is off: the next change shows its diff first.",
	"view.status.keyword": "Keyword search only",
	"view.status.indexing": "Indexing… {done} notes ({pending} left)",
	"view.status.index": "Index: {notes} notes, {chunks} chunks",
	"view.status.indexError": "Index: {error}",
	"view.status.calls": "{calls} tool call(s)",
	"view.status.secs": "{secs} s",
	"view.phase.loading": "Loading the model…",
	"view.phase.reading": "Reading the prompt…",
	"view.phase.readingTokens": "Reading about {tokens} tokens…",
	"view.phase.thinking": "Thinking…",
	"view.phase.thinkingRate": "Thinking… about {rate} tokens/s",
	"view.phase.writing": "Writing…",
	"view.phase.writingRate": "Writing… about {rate} tokens/s",
	"view.phase.tools": "Working…",
	"view.stats.firstToken": "first words after {time}",
	"view.stats.rate": "{rate} tokens/s",
	"view.stats.rateAbout": "about {rate} tokens/s",
	"view.stats.prompt": "{tokens} prompt tokens",
	"view.stats.load": "model loaded in {time}",
	"view.status.context": "Context {used} / {total} ({pct}%)",

	// Scheduled jobs while they run
	"job.running": "{job} is running in the background.",
	"job.stopping": "Stopping: {job}…",
	"job.stop": "Stop",
	"job.stopped": "{job} was stopped. Nothing was queued; it runs again at its next time, or now from the command palette.",
	"job.failed": "{job} failed: {error}",
	"job.failedRetry": "{job} failed ({error}). It will be tried again in {minutes} minutes.",
	"job.failedGaveUp": "{job} failed {n} times in a row ({error}). It will run again at its next scheduled time; you can also run it from the command palette.",
	"job.statusBar": "Scheduled job running",
	"job.statusBar.label": "{job} is running: click to stop it",

	// Approval dialog
	"approve.approve": "Approve",
	"approve.all": "Approve all in this chat…",
	"approve.allBatch": "Approve all remaining…",
	"approve.reject": "Reject",
	"approve.hint": "Enter approves · Esc rejects",
	"approve.hint.all": "Enter approves · Esc rejects · Ctrl/Cmd+Shift+A asks about approving all",
	"approve.confirm.chat": "Approve every further change in this chat without showing its diff? It stays on until you turn it off above the message box or start a new chat. Each change can still be undone.",
	"approve.confirm.batch": "Write the remaining changes of this batch without showing their diffs? Each change can still be undone from the change history.",
	"approve.confirm.yes": "Yes, approve all",
	"approve.confirm.back": "Back to the diff",
	"approve.diff": "Proposed change, line by line",

	// Report a problem
	"report.title": "Report a problem",
	"report.help": "This is what will go into the issue. Read it and edit anything you like; nothing is sent until you open it on GitHub yourself. Keys, tokens and your vault's paths are removed; note contents and chat text are left out unless you tick the box.",
	"report.what": "What happened?",
	"report.what.placeholder": "What did you do, what did you expect, what happened instead?",
	"report.chat": "Include the last chat (questions, answers and tool results; may contain note text)",
	"report.copy": "Copy",
	"report.open": "Open on GitHub",
	"report.copied": "Report copied to the clipboard.",
	"report.tooLong": "The report is long, so it was copied to the clipboard: paste it into the issue that just opened.",

	// Setup checklist
	"setup.title": "Setup checklist",
	"setup.help": "Everything the agent needs, checked live. Fix buttons only download models you choose; nothing else is installed.",
	"setup.server": "Model server reachable",
	"setup.chat": "A chat model that can call tools",
	"setup.embed": "Embedding model for semantic search",
	"setup.index": "Notes indexed",
	"setup.checking": "Checking…",
	"setup.recheck": "Check again",
	"setup.pull": "Download {model}",
	"setup.pulling": "Downloading {model}: {pct}",
	"setup.useModel": "Use {model}",
	"setup.buildIndex": "Build the index",
	"setup.openSettings": "Open settings",
	"setup.recommend": "Which model fits your machine?",
	"setup.rec.24": "24 GB GPU or more",
	"setup.rec.12": "12–16 GB GPU",
	"setup.rec.8": "8 GB GPU",
	"setup.rec.cpu": "Laptop or no discrete GPU",
	"setup.sample": "Try it on sample notes",
	"setup.done": "All set. Ask your notes anything.",

	// Survey
	"survey.question": "Quick question: how is Local Vault Agent working for you?",
	"survey.great": "It works well",
	"survey.problems": "It has problems",
	"survey.notUseful": "Not useful for me",
	"survey.dismiss": "Don't ask again",
	"survey.thanks": "Thank you. The link opens GitHub; nothing was sent.",

	// Notices (common)
	"notice.openNote": "Open a markdown note first.",
	"notice.selectText": "Select some text in a note first.",
	"notice.nothingUndo": "Nothing to undo.",
	"notice.wait": "Wait for the current reply to finish, or stop it, first.",
	"notice.queue.returned": "The reply failed, so the queued message was not sent. It is back in the message box.",
	"notice.turnDone": "Local Vault Agent: the reply is ready (it took {time}).",
	"notice.turnFailed": "Local Vault Agent: the reply failed after {time}.",
	"notice.jobRunning": "{job} is running in the background. Wait for it to finish, or stop it, first.",
	"notice.models.found": "Found {n} chat models.",
	"notice.models.found.one": "Found {n} chat model.",
	"notice.models.unreachable.ollama": "Could not reach Ollama: {error}",
	"notice.models.unreachable.server": "Could not reach the model server: {error}",
	"notice.insert.noNote": "Open a note in the editor first, or click into the one you mean.",
	"notice.insert.done": "Inserted at the cursor in {note}.",
	"notice.sampleCreated": "Created {n} sample notes in {folder}.",
	"notice.sampleExists": "The sample notes are already in {folder}.",
} as const;

export type I18nKey = keyof typeof en;
type Dictionary = Partial<Record<I18nKey, string>>;

/** Other languages: add a partial dictionary here; missing keys fall back to English. */
const LOCALES: Record<string, Dictionary> = { en };

let current: Dictionary = en;
let currentLocale = "en";

/** Picks the dictionary for a locale like "de" or "pt-BR" (falls back to the base language, then English). */
export function setLocale(locale: string | null | undefined): string {
	const l = (locale ?? "en").toLowerCase();
	const base = l.split(/[-_]/)[0];
	currentLocale = LOCALES[l] ? l : LOCALES[base] ? base : "en";
	current = LOCALES[currentLocale];
	return currentLocale;
}

export function locale(): string {
	return currentLocale;
}

/** The string for `key` with `{name}` placeholders filled in. */
export function t(key: I18nKey, vars: Record<string, string | number> = {}): string {
	const s = current[key] ?? en[key];
	return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Whether `key` is a known string (for optional descriptions). */
export function hasKey(key: string): key is I18nKey {
	return key in en;
}

/** Every English key, for tests that check other dictionaries. */
export function englishKeys(): I18nKey[] {
	return Object.keys(en) as I18nKey[];
}

/** The system-prompt line for the answer language: the question's own language unless one is set. */
export function answerLanguageLine(language: string): string {
	const l = language.trim();
	return l
		? `Always write your answers in ${l}, whatever language the question or the notes are in (quotes from notes stay as written).`
		: "Answer in the language the user writes in (quotes from notes stay as written).";
}
