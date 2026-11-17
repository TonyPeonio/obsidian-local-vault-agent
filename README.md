# Local Vault Agent

A fully local, agentic AI assistant for [Obsidian](https://obsidian.md), powered by
[Ollama](https://ollama.com). Nothing leaves your machine.

<!-- TODO(demo): record a 30–60 s GIF or video and put it here: install → setup checklist →
     "Try it on sample notes" → a question → the cited answer with its Passages line → an edit
     with the diff dialog → Undo. Save it as docs/demo.gif and replace the line below with
     ![Local Vault Agent answering from notes and showing a diff before it edits](docs/demo.gif) -->
*Demo video: coming soon.*

Ask it questions and it **searches your notes** to answer them. Ask it to **compile a topic**
and it reads the relevant notes and writes a new one with citations. Ask it to **reformat or
edit a note** and it shows you a diff that you approve before anything is written.

Local Vault Agent is part of the Companion suite of local-first Obsidian plugins by Tony Peonio for
students and researchers: your machine does the work, every change is a diff you approve, and the
numbers are published. The others are Lecture Companion (live local lecture transcription, Canvas
slides, Ollama summaries), Canvas Companion (Canvas LMS assignments, grades and announcements as
notes), Exam Companion (day-by-day study plan, daily quizzes and flashcards), Paper Companion
(Zotero search by meaning, page-cited reading notes), Research Log Companion (append-only lab
notebook with git, parameters, data hashes), Job Hunt Companion (job applications as notes, resume
tailoring, interview questions), Fellowship Companion (grants and fellowships: deadlines, materials,
letters, eligibility), Code Companion (commits in the daily note, weekly report, TODOs), Teaching
Companion (local-model rubric grading with verbatim evidence) and Branching Table of Contents
(parent/child properties as a rooted family tree). All at
[github.com/TonyPeonio](https://github.com/TonyPeonio).

- **Agentic.** The model decides which notes to search, read and edit using a small set of
  tools, and keeps going until it has an answer. It is not a one-shot "chat with a prompt".
- **Grounded.** Answers cite the notes they came from as wikilinks you can click, and link the
  exact paragraph they used (`[[note#^block]]`; for a lecture transcript, the `[m:ss]` paragraph).
- **Safe.** Every write to your vault goes through a diff-approval dialog. You can approve
  one change, approve everything in the current chat, or reject. Every approved change is kept in
  a change history with its own Undo.
- **For studying.** *Quiz me on a course since a date*, concept links that tie lectures from
  different courses to the same concept notes, and, with Lecture Companion, lecture transcripts as
  structured data and voice input.
- **Semantic + keyword search.** Notes are embedded locally with an Ollama embedding model
  and kept in sync as you edit. Keyword search always works as a fallback.
- **Free and open source.** MIT licensed. No accounts, no API keys, no telemetry.

## Why this one

Three things, each of which you can check rather than take on trust:

1. **Fully local.** The chat model, the embeddings and the vision model run on your machine
   through Ollama (or LM Studio, llama.cpp, Jan, vLLM). The plugin talks to the server URL you
   set and to nothing else; there is no account, no key and no telemetry, and the releases are
   built by GitHub Actions with provenance attestations.
2. **You approve every change.** The agent can edit, move and delete across many notes, and
   every one of those writes is a diff you approve first, recorded with what it replaced, and
   undoable later, even after you have edited the note further.
3. **The numbers are published.** Every release runs a scored benchmark on a generated vault
   (24 scenarios, the failures listed next to the passes), and the large-vault measurements at
   10,000 and 50,000 notes are in this README with the script that produced them.

How it compares, as fairly as I can put it (November 2026; these plugins move fast, so check
their own pages before deciding):

| | Local Vault Agent | [Copilot for Obsidian](https://github.com/logancyang/obsidian-copilot) | [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) | [Text Generator](https://github.com/nhaouari/obsidian-textgenerator-plugin) |
|---|---|---|---|---|
| Main idea | An agent that searches, reads and edits the vault with tools | Chat with your vault and with many model providers | Related notes by meaning, plus a chat | Text generation from prompts and templates |
| Models | Local only (Ollama or an OpenAI-compatible local server) | Cloud providers and local ones | Local embeddings by default; chat through providers you configure | Many providers, cloud and local |
| Edits to notes | Any note, always through a diff you approve, with history and undo | Mostly inserts into the open note; agentic features are part of its paid tier | Not its focus | Writes generated text where you ask |
| Citations | Wikilinks, down to the paragraph | Links to source notes | Links to related notes | None by design |
| Published accuracy benchmark | Yes, per release | Not that I know of | Not that I know of | Not that I know of |
| Polish, community, integrations | One author, a small user base | Large community, far more features and integrations | Large community, very good at "what is related to this note" | Mature template ecosystem |

Where the others are the better choice: if you want the strongest models and do not mind your
notes going to a cloud API, Copilot with a frontier model will answer harder questions than a
9B model on your GPU. If what you want is "show me notes related to this one" while you write,
that is exactly Smart Connections. If you want prompt templates that fill in frontmatter and
generate drafts, that is Text Generator. This plugin is for people who want an assistant that
*works on* the vault, and want it without anything leaving the machine.

## Getting started

1. Install [Ollama](https://ollama.com) and start it (or use another local server, see
   [Other local servers](#other-local-servers)).
2. Open the chat (robot icon in the ribbon). The first time, a **setup checklist** opens: it
   checks that the server is reachable, that there is a chat model that can call tools, an
   embedding model and an index, and offers one button per missing piece: download the model that
   fits your machine (with progress), switch to one you already have, build the index. It is also
   the command **Setup checklist**.
3. Click **Try it on sample notes**: it creates a small folder (`Local Vault Agent sample`, five
   linked notes: a project with a decision in it, a person, a lecture with a timestamped
   transcript, a daily note) and shows three questions to click. You get a cited answer about
   notes you can read in a minute, before pointing it at your own. Delete the folder whenever you
   like.

## Requirements

1. [Ollama](https://ollama.com) installed and running.
2. A chat model that supports **tool calling**. Recommended, by GPU size:
   - 12 GB VRAM (e.g. RTX 3060/4070/5070): `ollama pull qwen3.5:9b` (default; the model the
     [benchmark](#benchmarks) is measured on). The older `qwen3:14b` scored much lower.
   - 8 GB VRAM: `ollama pull qwen3.5:4b` (108 of 115 benchmark checks in under two minutes; see Benchmarks)
   - 24 GB VRAM: `ollama pull qwen3.5:35b-a3b`. On a 12 GB card it spills into system RAM and
     was both slower and less accurate than the 9B; stay with the 9B there.
3. An embedding model for semantic search: `ollama pull nomic-embed-text` (274 MB).

The plugin checks all of this for you: the **setup checklist** (first open of the chat, or the
command), and **Settings → Local Vault Agent → Test connection and speed**.

### Other local servers

*Settings → Provider → OpenAI-compatible* talks to any local server with the OpenAI API:
`/v1/chat/completions` (streamed, with tool calls), `/v1/embeddings` and `/v1/models`.

| Server | Server URL |
|---|---|
| LM Studio (enable the local server) | `http://localhost:1234/v1` |
| llama.cpp `llama-server` (start it with `--jinja` for tool calls) | `http://localhost:8080/v1` |
| Jan | `http://localhost:1337/v1` |
| vLLM (`--enable-auto-tool-choice --tool-call-parser hermes` for Qwen) | `http://localhost:8000/v1` |

Pick a chat model that supports tool calling and load an embedding model in the same server (set
its id as the *Embedding model*), or turn semantic search off. An API key can be set if your
server asks for one; it is stored in the plugin's settings, sent only to that server, and never
included in a problem report. Ollama stays the default and is what the benchmark measures: with
other servers the context window is whatever you loaded the model with, the speed test, model
download and the automatic vision check are not available (set a *Vision model* by hand), and
tool calling is only as good as the server's chat template. This path is covered by unit tests
against the wire format, not by a run against each of the four servers; if one misbehaves, use
*Report a problem*.

### Languages

The agent answers in the language you write in; *Settings → Answer language* fixes one instead
(`Deutsch`, `Español`, `日本語`, …). Notes are quoted as written. The interface is in English;
every interface string lives in one dictionary ([`src/i18n.ts`](src/i18n.ts)) with English as the
fallback, so a translation is one more dictionary of the same keys: pull requests welcome.

## Usage

Click the robot icon in the ribbon, or run the command **Local Vault Agent: Open chat**.

Things to try:

- *"What have I written about X?"*
- *"Summarize my notes on X from the last month."*
- *"Compile everything I know about X into a new note called 'X Summary' and cite the sources."*
- Open a messy note and run **Reformat the current note**.
- Select some text and run **Ask about the selected text**, or **Edit the selected text with an
  instruction** ("make this a table") and approve the diff.
- Run **Process my daily notes**: the loose captures in your daily notes become topic notes,
  the daily notes stay timelines.
- Run **Suggest vault improvements** for a checklist of broken links, unlinked mentions,
  duplicates, orphans and full inboxes, then ask the agent to work through a section.
- *"Quiz me on CSCI 470 since October 1"*: questions from those lectures, one at a time, each
  answer graded against the paragraph it came from; the missed ones go to a review note.
- Open a lecture and run **Suggest concept links for this note**.
- *"What does the whiteboard photo in [[Robot meeting]] say?"* — images are read with a local
  vision model.

### Commands

| Command | What it does |
|---|---|
| Open chat | Opens the sidebar chat |
| Ask about the selected text | Opens the chat with your selection quoted, ready for a question |
| Edit the selected text with an instruction | One-line instruction, then a diff of exactly the passage you selected (`/edit`) |
| Reformat the current note | Asks the agent to tidy the open note into clean markdown (diff-approved) |
| Summarize the current note | Bullet-point summary of the open note |
| Process my daily notes | Compiles the inbox sections of your daily notes into topic notes with source links and leaves a link behind (`/daily`) |
| Suggest vault improvements | Reports in the chat, with a button per section: broken links, full inboxes, unlinked mentions, duplicates, orphans, stubs (`/garden`). Writes nothing itself; the mechanical fixes need no model |
| Rebuild semantic index | Re-embeds every note from scratch |
| Rebuild note gists | Regenerates the one-sentence gist of every note |
| Undo the agent's last change | Reverts the most recent approved write (diff-approved) |
| Undo every change from the agent's last message | Reverts that message's writes, newest first |
| Show change history | Every approved change, newest first, with its diff and an Undo button (`/history`) |
| Quiz me on a topic or course | Topic, since when, how many questions; the quiz runs in the chat (`/quiz`, or type *quiz me on … since …*) |
| Suggest concept links for this note | Concept notes the open note mentions or is close to, linked in one diff, optionally as `parent`/`child` properties (`/concepts`) |
| Review changes from scheduled jobs | Walks the changes the nightly and weekly jobs queued, as diffs (`/review`) |
| Run the nightly daily-notes job now | Runs the scheduled job immediately; its changes wait for review |
| Write this week's digest now | Runs the weekly digest immediately; the note waits for review |

### How it works

The model gets twenty tools. Reading: `search_passages` (matching note *sections*, verbatim),
`search_notes`, `grep_vault` (grep every note for a string or regex, each match tagged with its
heading), `list_sections` (one heading surveyed across notes with size and first line, or which
sections contain which texts), `read_note`, `read_section`, `find_in_note`, `list_notes` (folder,
tag, name, size, modified dates), `list_files`, `read_file` (text of PDFs and text attachments),
`vault_overview`, `get_active_note`. Writing: `create_note`, `edit_note`, `edit_notes` (many edits
across notes in one call, one approval per note), `append_to_note`, `replace_section` (rewrite or
empty everything under a heading), `replace_note`, `move_note` (links are updated) and
`delete_file` (notes *or* attachments, to the trash). Three more are offered when they can work:
`list_lectures` and `lecture_transcript` when Lecture Companion is installed, `read_image` when a
vision model is available. It calls
them in a loop until the task is done, then reports. Every write opens an approval dialog with a
line diff before touching the vault (Enter approves, A approves all in this chat, Esc rejects).

**What it sees on every message.** Besides your question, the model gets an outline of the whole
vault — every note's folder, name, headings and tags, budgeted to the context window — and, when
*Note gists* is on, a one-sentence gist of each note written by the chat model in the background
(paused while you chat, cached until the note changes). Together with the per-heading semantic
index that is how it "knows" a 200-note vault that could never fit in context. A **conventions
note** (`AGENT.md` by default, like a CLAUDE.md) is included verbatim: folder meanings, naming
rules, things never to touch.

**Autonomy.** The agent is told to finish multi-note tasks on its own rather than stopping after
each step to ask "shall I proceed?". If a model asks anyway, the agent answers yes for you up to
three times per message (a small note appears in the chat) — see *Keep going when the model asks
for permission* in settings. It never does this for a question that offers you a choice, nor after
you have rejected a change in that message, and a question always gets an answer rather than edits.

**Process my daily notes.** Daily notes collect loose captures: a list of fellowships, a lecture
brain-dump, a shell command, names of people to email. The command surveys the inbox section
(`## Capture` by default; the dialog lets you change it) of every daily note in one call, compiles
the substantial ones into topic notes under `Topics/` with a *Sources* section linking each source
day, gathers code blocks into a *Code snippets* note, and replaces each compiled inbox with
`- Moved to [[Topics/…]]` so the daily notes keep their timelines. Empty inboxes and one-liners
are left alone. Limit it to the last 30/90/365 days, or turn moving off to keep the daily notes
untouched. Every write is a diff you approve.

**Edit the selected text.** Select a passage, run the command (or `/edit`), type what should
change. The agent edits exactly that passage; you see a diff of it and nothing else.

**Vault suggestions.** *Suggest vault improvements* (`/garden`) reads the whole vault in under a
second, without the model, and reports in the chat: broken links, daily inboxes that filled up,
notes whose names appear in other notes without a wikilink, duplicate notes, orphans and stubs. It
writes nothing to the vault and never creates tasks or checkboxes, so task queries over the vault
stay clean. Under the report is one button per section, and each acts on the findings listed:

- *Repoint moved links* — a link like `[[Old folder/Note]]` whose note now lives elsewhere is
  rewritten to where it is (only when exactly one note or file has that name).
- *Link mentions* — the first plain mention of a note's name becomes `[[path|the words as written]]`.
- *Remove identical copies* — when the same text exists twice (a copied folder, a sync conflict),
  links to the copy are repointed to the note that stays and the copy goes to the trash.
- *Process daily inboxes* opens the daily-notes dialog.
- *Review similar notes* and *Suggest links for orphans* ask the model for a proposal, which you
  then accept in your own words; these two are the only ones that take model time.

The first three are worked out by the plugin itself, not the model: you get the same diff dialog as
for any agent edit (with *Approve all*), the result in the chat a moment later, and `/undo-all`
takes the batch back. What counts as a finding is deliberately strict: a single ordinary word is
never a "mention" (a note called *Classes* is not mentioned by every note that says classes), a
capitalised name is matched as written, lectures that share a template and a slide deck are not
duplicates, and a note that is one query block is not a stub. Folders another plugin fills with its
own files (chat logs, skill definitions) are best added to *Excluded folders*. If an earlier
version left a *Vault Suggestions* note behind, the report offers to move it to the trash.

**Test connection and speed.** The settings button runs a short generation at your context size
and asks Ollama how much of the model is on the GPU. You get a verdict in plain words and a
button for what to do: a larger context when there is room, a smaller one or a smaller installed
model when it is spilling into RAM, and a warning if the chosen model cannot call tools.

**Not getting stuck.** Small models loop: they grep the same pattern again and again, or read
`Daily/<every date>` hoping one exists. The agent refuses a read-only call it has already run with
the same arguments in the turn (it shows the model the earlier result instead), and ends the turn
with a wrap-up answer at the third repeat. A path that does not exist comes back with the notes
that do exist in that folder, `list_notes` shows every note's size, and a regex sent as literal
text is recognised and searched as a regex.

**Undo and the change history.** Every approved write is recorded with what it replaced, the
time, and the chat and message it came from, in `history.json` in the plugin's folder (the last 300
changes; it survives restarts). *Show change history* (`/history`) lists them newest first with the
diff and an **Undo** button; *Undo the agent's last change* and *Undo every change from the agent's
last message* are commands (also `/undo`, `/undo-all`), and each tool card has an **Undo** button
too. A revert is shown as a diff and applied only when approved. If the note was edited after the
change, only the change is taken back and the later edits stay; if the later edits overlap it, the
undo is refused rather than overwriting them. An undo is itself in the history and can be undone.

**Paragraph citations.** Under an answer drawn from notes, a *Passages* line links the exact
paragraphs it used: the ones it quotes, the transcript paragraphs whose `[m:ss]` it names, or the
ones it paraphrases closely. A paragraph that already has a block id is linked as
`[[note#^id]]`. One that has none gets an id proposed, `^t21-29` for a transcript paragraph at
21:29, otherwise a short hash, and since that is a write, all of one answer's ids for a note are a
single diff you approve; reject it and the link points at the paragraph's heading instead
(`[[note#Transcript|note › 21:29]]`), which needs no write. *Settings → Paragraph citations* can
make it headings only (never writes) or turn it off.

**Quiz me.** *"Quiz me on CSCI 470 since October 1"* (or the command, or `/quiz`) picks the notes:
the course's lectures from Lecture Companion when it is installed, otherwise notes whose path has
the topic's words, otherwise a search. Dates can be written as `2026-10-01`, `last week`,
`the last 2 weeks`, `monday`, `Oct 3`. The chat model writes the questions with the notes in front
of it (a question whose source is not one of those notes is dropped), the chat asks them one at a
time, and each answer is graded against the source passage, with the answer and a link to the
paragraph. *skip* passes, *stop* ends. At the end the missed ones are added to
`Quiz reviews/Quiz review - <topic>.md` as a dated section, after you approve the diff; no
checkboxes, so task queries stay clean.

**Concept links.** *Suggest concept links for this note* (`/concepts`) looks for your concept or
topic notes (in the *Concept folders*, `Concepts` and `Topics` by default, or tagged `#concept`,
or `type: concept`) that the open note mentions, by name or alias, and, with the semantic index,
the ones it is close to without naming. You tick which to use; the first plain mention of each
becomes a wikilink, the related ones go under `## Related concepts`, and optionally all of them are
recorded as `parent` (or `child`) link properties, the shape Branching Table of Contents reads,
so a concept collects the lectures of every course that discusses it. One diff for the whole change.

**Scheduled jobs.** In settings, a nightly *Process my daily notes* and a weekly digest note
(the notes you created or changed that week, summarised by theme with links, plus the full list).
Obsidian has no background service, so a job runs when Obsidian is open at or after its time,
checked at start-up and every minute. A job never writes: it runs against an in-memory overlay of
the vault, and what it would have written waits in `pending.json` until you are back at the
keyboard, when a notice and a status-bar badge (*🤖 3 to review*) offer the review. Each change is
then an ordinary diff; one whose note you edited in the meantime is carried over when the edits do
not overlap and skipped when they do. The commands *Run the nightly daily-notes job now* and
*Write this week's digest now* run them on demand.

**Images and scans.** With a vision model the agent gets `read_image`: it transcribes the text in
an image (printed or handwritten) and describes diagrams, charts and photos, and it reads scanned
PDF pages that have no text layer (rendered with Obsidian's PDF viewer). `read_note` tells the model
which images a note embeds, and `read_file` which PDF pages are scans. The picture is sent to Ollama
base64 in the message's `images`; readings are cached by the file's content hash in
`image-cache.json`, so an image is read once. *Settings → Vision model*: empty uses the chat model
when it can see (`qwen3.5` can), or set one such as `qwen2.5vl:7b`. Without one the tool is simply
not offered.

**Lecture Companion.** When [Lecture Companion](https://github.com/TonyPeonio) is installed and
enabled, the agent reads its records through its API instead of relying on the conventions it
appends to `AGENT.md`: `list_lectures` (course, date, kind, one-sentence summary) and
`lecture_transcript` (the paragraphs that match a query, with their `[m:ss]` and neighbours). So
"when did the professor say X" is answered from structured data, and the citation links the
transcript paragraph. Without it, the search path and the `AGENT.md` conventions work as before.
The chat also gets a **mic button**: it records, converts to 16 kHz mono WAV and transcribes through
Lecture Companion's whisper server into the message box. Without Lecture Companion there is no mic
button. Settings show a button to use Lecture Companion's Ollama URL and model, so both plugins
share one Ollama and one model in memory.

**Composer.** `@` picks a note to attach to your message (its content is included, so no tool call
is needed); `/` lists commands (`/reformat`, `/summarize`, `/undo`, `/undo-all`, `/new`, `/gists`,
`/index`, `/quiz`, `/concepts`, `/history`, `/review`, `/help`). The header has a **Copy conversation** button that copies the whole chat,
including tool calls and results, as markdown. The footer shows index and gist status, the tool-call count and elapsed time while a turn
runs, and the context used by the last model call. The chat is saved and restored when you reopen
the panel or restart Obsidian; **New chat** clears it.

Semantic search chunks each note by heading, embeds the chunks with the embedding model, and
stores the vectors in `.obsidian/plugins/local-vault-agent/index.json`. The index updates
incrementally when you change notes. Search results merge semantic and keyword rankings.

## Settings worth knowing

- **Context window (`num_ctx`)** — default 32768, and leave it there. Ollama's own default of
  4096 is far too small for reading notes; if answers seem to ignore what the tools returned, this
  is usually why. Larger is not better: the benchmark scored the same at 64k, and since 0.5.3 the
  conversation the agent carries is capped at the 32k budget whatever the window is, so a bigger
  window only buys KV cache. That cache is what hurts on a 12 GB card: `qwen3.5:9b` at 96k needs
  several GB more than at 32k, Ollama then evicts the embedding model to make room, and every
  search step reloads the chat model and re-reads the whole conversation. 0.5.3 brings a window
  above 32k back to 32k once; set it again if you have the VRAM. `OLLAMA_FLASH_ATTENTION=1` and
  `OLLAMA_KV_CACHE_TYPE=q8_0` on the Ollama server halve the KV cache with no visible quality
  loss. `qwen3:14b` needs ~9.3 GB for weights alone and tops out around 32k.
- **If it feels slow** — in order of likelihood: the model is partly in system RAM (the plugin
  now says so after a turn, with the fix: a smaller window or `qwen3.5:4b`); thinking is on (off
  by default since 0.5.0, as fast and as accurate on the benchmark); the gist pass is running
  (off by default since 0.5.3; it is the chat model once per note); or Ollama was started with
  another app's model still loaded. On a 12 GB RTX 5070 a 20-scenario benchmark run takes about
  three minutes with the defaults, roughly nine seconds per question with tool calls.
- **On a laptop without a discrete GPU** — measured on a Ryzen 7940HS with its integrated Radeon
  780M: `qwen3.5:9b` reads a prompt at about 170 tokens a second and writes about 6.5. The system
  prompt, outline and tool list are about 8,000 tokens, so the first message after the model loads
  spends close to a minute reading before it writes anything; after that Ollama reuses what it has
  read and a new message starts in about a second, as long as the model stays loaded. So set **Keep
  model loaded** well above the pauses between your messages (30m): an integrated GPU draws nothing
  for a loaded, idle model, while every unload costs that minute again. Writing speed is the floor;
  only a smaller model or a discrete GPU moves it.
- **Temperature** — default 0.6, with top_p 0.9, top_k 20 and a small presence penalty always
  sent. That follows the Qwen3 model card, which warns that near-greedy decoding "can lead to
  performance degradation and endless repetitions": at 0.3 we watched a 9B model repeat the same
  search sixty times. Lower is not more precise for an agent.
- **Note gists** — on by default. The first pass over a large vault takes a few minutes of GPU
  time in the background; turn it off on a laptop that shares the GPU with other work.
- **Conventions note** — `AGENT.md` by default; *Create / open* writes a starter you can edit.
- **Thinking mode** — Qwen3 / DeepSeek-R1 style reasoning, **off by default**. On the benchmark
  vault `qwen3.5:9b` passed as many checks without thinking as with it, in a third of the time
  and with fewer tool calls (see Benchmarks); the agent loop already gives the model a step at a
  time to reason about. "Auto" uses the model default; "On" forces it.
- **Auto-approve edits** — off by default. Leave it off; use "Approve all in this chat" in the
  dialog when you trust a particular task.
- **Keep going when the model asks for permission** — on by default. Turn it off if you prefer
  the model to stop and check in with you after each step.
- **Max tool calls per message** — default 40. A clean-up across many notes needs two or three
  calls per note; raise it if the agent reports it ran out.
- **Excluded folders** — folders the agent never searches, indexes or edits (templates, etc.).
- **Extra instructions** — appended to the system prompt. Tell it about your vault's conventions.
- **Paragraph citations** — *Block ids* (default: ids added on approval), *Headings only* (never
  writes) or *Off*.
- **Vision model** — empty: the chat model when it can see; or e.g. `qwen2.5vl:7b`. *Check* says
  which model will read images.
- **Concept folders**, **Quiz questions** (5), **Quiz review folder** (`Quiz reviews`).
- **Scheduled jobs** — nightly daily-notes processing (02:00), weekly digest (Sunday 18:00, into
  `Digests/`), both off by default; *Review now* when changes are waiting.
- **Use Lecture Companion's Ollama settings** — shown when Lecture Companion is installed.

### Ollama from a different machine or on mobile

Set the Ollama URL to a LAN address (e.g. `http://192.168.1.10:11434`) and start Ollama with
`OLLAMA_HOST=0.0.0.0`. Modern Ollama already allows requests from Obsidian (`app://*`); if you
see a CORS/network error, set `OLLAMA_ORIGINS=app://obsidian.md*` on the Ollama server.

## Benchmarks

Every release is run through a scored benchmark: 24 scenarios on a generated 339-note vault
(questions across notes, a follow-up turn that must use the conversation, a question with no
answer in the vault, quoting a lecture transcript with its `[m:ss]` timestamp through the
Lecture Companion block in `AGENT.md`, enumeration, a clean-up over 40 lecture sections, moving finished projects,
processing 127 daily notes, acting on the Vault Suggestions note, editing a selection, a note
that does not exist, a change the user rejects, and the loop failures reported from real vaults).
Each scenario is timed and counted for tool calls, model calls, model time, tool errors, guessed
paths, invented links and repeated calls, and checked against facts the generator recorded.
122 checks in all; the vault is restored after every run.

Versions 0.5.1 and 0.5.3, 2026-11-07/08, RTX 5070 12 GB, Ollama 0.40, 32k context unless noted. Identical
runs differ by up to 2× in wall time, so the defaults were run many times over the night.

| Configuration | Checks | Seconds | Model s | Tool calls | Repeats |
|---|---:|---:|---:|---:|---:|
| **0.5.3, qwen3.5:9b, defaults (history capped at 32k, gists off)** | **120** | **307** | 292 | 113 | 1 |
| 0.5.3, same, 96k context (history still capped at 32k) | 119 | 263 | 251 | 74 | 0 |
| **qwen3.5:9b, defaults (thinking off, temp 0.6), final build, 20 scenarios / 122 checks** | **121, 120, 120** | **167, 184, 197** | 162, 178, 192 | 64, 79, 64 | 0, 1, 0 |
| same build on the 19-scenario / 115-check set earlier the same night | 113, 113, 112 | 151, 243, 155 | 147, 237, 138 | 65, 186, 66 | 0, 0, 3 |
| qwen3.5:9b, defaults, with the Lecture Companion scenario (20 scenarios, 122 checks) | 119, 118 of 122 | 173, 265 | 165, 238 | 59, 94 | 0, 3 |
| qwen3.5:9b, defaults, earlier 0.5.1 builds the same night (10 runs) | 108–114 | 157–262 | | 61–99 | 0–3 |
| qwen3.5:9b, note gists on | 113 | 231 (+230 to gist 334 notes once) | 206 | 110 | 0 |
| qwen3.5:9b, 64k context | 112 | 308 | 294 | 208 | 0 |
| qwen3.5:9b, thinking on | 112 | 444 | 436 | 126 | 1 |
| qwen3.5:4b, thinking off (8 GB cards) | 108 | 112 | 88 | 80 | 5 |
| 0.5.0 code, same model and settings | 92, 89, 87 of 96 | 395, 246, 486 | | 97, 149, 111 | 0, 3, 2 |
| 0.5.0: temperature 0.3, presence 0 | 93, 90 of 96 | 146, 263 | | 61, 207 | 3, 3 |
| 0.5.0: qwen3:14b, thinking off | 82 of 96 | 521 | | 66 | 0 |
| 0.5.0: qwen3.5:35b-a3b, thinking on (56% in system RAM) | 84, 87 of 96 | 934, 1192 | | 114, 260 | 0, 3 |
| 0.4.1 (71 checks, 9 scenarios then) | 66 of 71 | 397 | | 198 | 4 |

What the numbers say:

- **Model time is 90–97% of wall time**, so the loop itself costs little; the way to be faster
  is fewer or shorter model calls, which is what every fix below did.
- **Thinking off is the default.** With thinking on the same build passed 112 in 444 s against
  114 in 202 s; the loop already gives the model one step at a time to reason over.
- **The 0.5.1 fixes came from reading the transcripts of failed runs**, not from prompt
  tinkering: a survey call that returned an empty result the model read as "that section does
  not exist" (the tool now says the sections exist and lack the text), a prompt that demanded
  one giant `edit_notes` call (an 18-edit call made the 9B emit nothing; now at most 8 per call),
  a survey whose per-section flags the model re-checked by reading every section (the result now
  marks the sections that have every text and says to act on them), and a rejected diff after
  which the model said "Done" (every further write in that turn is now refused and the reply
  ends by asking the user). The clean-up scenario went from passing 0 of 3 runs to most runs; when the model takes the survey path it finishes in two calls and about 20 s.
- **qwen3.5:4b is a real option on an 8 GB card:** 108 of 115 in under two minutes. It loses on
  the long multi-note jobs (the clean-up, listing unsummarised recordings) and repeats itself
  more.
- **0.5.3's history cap holds at a large window:** the same build at 96k passed 119 in 263 s with
  74 tool calls, where 0.5.1 at 64k took 308 s and 208 calls. Ollama still swapped the chat and
  embedding models in and out 15 times during that run on the 12 GB card (once at 32k), which is
  why the plugin brings a window above 32k back down. The 32k run's 307 s is the known clean-up
  variance: that scenario took 157 s and 47 calls on the grep-and-read path; the other 19
  scenarios took 150 s, the same as 0.5.1.
- **64k context did not help** on this vault (112, slower, far more tool calls); gists bought one
  check for a one-time 230 s of GPU work on this card, which is an hour on a laptop GPU with a
  large vault. 32k stays the default and gists are off by default since 0.5.3 (one toggle to turn
  on); the embedding index, which search depends on, is separate and stays on.
- **A bigger model does not help on a 12 GB card:** the 35B spilled into RAM and scored lower;
  the older `qwen3:14b` sent 45 tool calls in one step.
- Remaining misses are single checks that move between runs: a daily survey that lists one
  one-liner day too many, a conventions note written under the wrong heading, and about one
  clean-up run in four where the model greps and reads instead of surveying and runs out of
  steps without editing.

**Vault size.** The same benchmark on a 3× vault (997 notes: the 339 above plus 660 filler
notes in `Zettel/`, `Library/` and `Archive/2024/`, 1.9 M characters) with the defaults scored
110 of 115 in 214 s with 83 tool calls (339 notes the same night: 112, 155 s, 66 calls). The
index took 47 s instead of 8–10 s, the system prompt grew from ~5.0k to ~6.2k tokens and each
scenario's largest prompt by 1.5–2.5k tokens; the misses were a follow-up turn that re-read its
source, a malformed tool call, a repeated survey, an answer that dropped a fact it had stated a
step earlier, and the clean-up deleting three unsummarised embeds after grepping instead of
trusting its survey — the same single-check misses seen at 339 notes, none caused by a note the
agent could not find. One real defect did show: at ~1000 notes the outline no longer fit even as
bare file names and fell back to an alphabetical prefix, so `School/`, `Projects/`, `People/`,
`Meetings/` and `Research/` vanished from the system prompt while `Archive/` and 127 daily
dates used the budget. Folders that do not fit now collapse to one line with their note count
and name range, and every folder stays on the map; with that fix the 3× run scored 114 of 115
with 79 calls and a ~5.1k-token system prompt, in 316 s of which 171 s was the clean-up taking
its known grep-and-read path (every other scenario finished in 3–41 s, as at 339 notes). Three
more runs of the final build on the 3× vault scored 110, 114 and 115 of 115 in 162–307 s, so
the size itself costs little once the outline keeps every folder. Reproduce with
`SCALE=3 OUT=test-vault-x3 node scripts/make-vault.mjs` and
`VAULT_DIR=test-vault-x3 TAG=scale3 npm run e2e:large`; results are in `bench/0.5.1-scale3*`.

**0.7.0 scenarios.** Four new scenarios and one new check cover the new features: `lecture-tools` (the same transcript
question answered through a fake of Lecture Companion's API, which must use `lecture_transcript`
and link the paragraph by its new `^t21-29` block id), `quiz` (five questions from three lectures,
each citing a paragraph; the expected answer graded correct and an unrelated one wrong),
`scheduled-daily` (the nightly job in an overlay: the real vault must stay untouched while the
topic notes and inbox edits come back as queued changes), `read-image` (a number drawn in a PNG
that a note embeds, read with `qwen3.5:9b`'s own vision) and a passage-link check added to
`lecture-timestamp`. Run with `ONLY=lecture-timestamp,lecture-tools,quiz,scheduled-daily,read-image`
on 2026-11-17 (Ollama 0.40, `qwen3.5:9b`, on a machine reading prompts at about 170 tokens a second,
so the times are far above the RTX 5070 rows): 32 of 34 checks. `lecture-timestamp` 8/8 and
`lecture-tools` 10/10 (the block id was written to the quoted paragraph), `quiz` 5/5, `scheduled-daily`
4/5 (three topic notes and three inbox edits queued, vault untouched; the model left out the
*Sources* section the prompt asks for), `read-image` 5/6 (the tool was used, but the model read the
blocky "47" as "41"). The full 24-scenario run was not repeated for this release.

Run it yourself with `npm run make-vault && npm run e2e:large` (see Development); results land
in `bench/`.

## API for other plugins

Local Vault Agent exposes `app.plugins.plugins["local-vault-agent"].api`:

```ts
interface LocalVaultAgentApi {
  version: 1;
  /** Opens the chat with the note attached (as an @-mention) and the cursor ready for a question. */
  openChatAbout(path: string): Promise<void>;
  /** The Ollama URL and chat model this plugin uses, for sharing one setup. */
  ollama(): { url: string; model: string };
}
```

It uses Lecture Companion's API (`app.plugins.plugins["lecture-companion"].api`, `version: 1`)
when present:

```ts
interface LectureCompanionApi {
  version: 1;
  courses(): string[];
  lectures(course?: string): { path: string; course: string; date: string; kind: "lecture" | "meeting"; sentence: string | null }[];
  transcript(path: string): Promise<{ start: number; text: string }[]>; // start in seconds
  transcribe(wav16kMono: ArrayBuffer): Promise<string>;
  ollama(): { url: string; model: string };
}
```

Check `version === 1` before use; a later version may change the shape. Both are read on use, so
enabling or disabling a plugin takes effect without a restart.

## Privacy and network use

This plugin makes HTTP requests only to the Ollama URL you configure (default
`http://localhost:11434`). It sends your prompts and the contents of notes the agent reads to
that server. It never contacts any other host and collects no telemetry.

What it touches in your vault, and why:

- **Lists all notes** (`vault.getMarkdownFiles`) to search, index and let the agent browse. Folders in
  *Excluded folders* are skipped.
- **Reads notes** the agent chooses to open, and **writes** only after you approve a diff.
- **Writes to the clipboard** only when you click *Copy* on a reply. It never reads the clipboard.
- **Uses the microphone** only while the mic button is on (it exists only with Lecture Companion).
  The recording goes to Lecture Companion's `transcribe`, which sends it to the whisper server
  configured there; this plugin sends it nowhere else and keeps no copy.
- **Reads images** a note embeds, and PDFs, only when the agent calls `read_image`; they go to the
  same Ollama server.
- Stores the search index, the chat, the change history (`history.json`, with the text each change
  replaced), queued scheduled changes (`pending.json`) and image readings (`image-cache.json`) in
  the plugin's own folder inside your vault's config directory.

Releases are built by GitHub Actions from the committed lockfile and carry
[artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds),
so you can verify a release's `main.js` came from this repository's source.

## Development

```bash
npm install
npm run dev     # watch build → main.js
npm test        # unit tests (vitest), no Ollama needed
npm run e2e     # runs the real agent loop against a live Ollama over ./test-vault
npm run make-vault && npm run e2e:large   # the scored benchmark (see Benchmarks)
npm run build   # type-check + Obsidian review lint + production bundle
```

The benchmark (`scripts/e2e-large.ts`) runs 24 scenarios on a generated 339-note vault
(`scripts/make-vault.mjs`, with `scripts/large-facts.json` recording the facts the checks look
for) and saves per-scenario seconds, tool calls, errors, guessed paths, repeated calls and
pass/fail to `bench/<version>[-tag].json`. `MODEL=`, `NUM_CTX=`, `THINK=on|off`, `TEMPERATURE=`,
`PRESENCE=`, `GISTS=1`, `VISION_MODEL=`, `TAG=` and `ONLY=id,id` select what runs; `VAULT_DIR=` points it at a
vault generated with `SCALE=3 OUT=test-vault-x3 node scripts/make-vault.mjs` (the same 339
notes plus 660 filler notes in their own folders, facts in `scripts/large-facts-test-vault-x3.json`). `npm run bench-matrix` runs
several configurations back to back (`RUNS=2` for variance) and prints one table;
`npm run bench-table a.json b.json` renders a before/after comparison. Add a scenario whenever a
real-vault failure is reproduced; the results in `bench/` are the release gate.

To release: bump `version` in `manifest.json` and `package.json`, add the version to
`versions.json`, write `release-notes/<version>.md`, commit, then push a tag named exactly
`<version>`. The release workflow builds, tests, attests and publishes the GitHub release.

`test-vault/` is a small sample vault. To try the plugin in Obsidian, open that folder as a
vault and copy `main.js`, `manifest.json` and `styles.css` into
`test-vault/.obsidian/plugins/local-vault-agent/`.

The core (`agent.ts`, `tools/`, `search.ts`, `index.ts`, `ollama.ts`) has no Obsidian
dependency and is unit-tested against an in-memory vault; `obsidian-vault.ts`, `view.ts` and
`main.ts` are the thin Obsidian layer.

## License

MIT
