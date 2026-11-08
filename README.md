# Local Vault Agent

A fully local, agentic AI assistant for [Obsidian](https://obsidian.md), powered by
[Ollama](https://ollama.com). Nothing leaves your machine.

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
- **Grounded.** Answers cite the notes they came from as wikilinks you can click.
- **Safe.** Every write to your vault goes through a diff-approval dialog. You can approve
  one change, approve everything in the current chat, or reject.
- **Semantic + keyword search.** Notes are embedded locally with an Ollama embedding model
  and kept in sync as you edit. Keyword search always works as a fallback.
- **Free and open source.** MIT licensed. No accounts, no API keys, no telemetry.

## Requirements

1. [Ollama](https://ollama.com) installed and running.
2. A chat model that supports **tool calling**. Recommended, by GPU size:
   - 12 GB VRAM (e.g. RTX 3060/4070/5070): `ollama pull qwen3.5:9b` (default; the model the
     [benchmark](#benchmarks) is measured on). The older `qwen3:14b` scored much lower.
   - 8 GB VRAM: `ollama pull qwen3.5:4b` (108 of 115 benchmark checks in under two minutes; see Benchmarks)
   - 24 GB VRAM: `ollama pull qwen3.5:35b-a3b`. On a 12 GB card it spills into system RAM and
     was both slower and less accurate than the 9B; stay with the 9B there.
3. An embedding model for semantic search: `ollama pull nomic-embed-text` (274 MB).

The plugin checks all of this for you: **Settings → Local Vault Agent → Test connection**.

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

### Commands

| Command | What it does |
|---|---|
| Open chat | Opens the sidebar chat |
| Ask about the selected text | Opens the chat with your selection quoted, ready for a question |
| Edit the selected text with an instruction | One-line instruction, then a diff of exactly the passage you selected (`/edit`) |
| Reformat the current note | Asks the agent to tidy the open note into clean markdown (diff-approved) |
| Summarize the current note | Bullet-point summary of the open note |
| Process my daily notes | Compiles the inbox sections of your daily notes into topic notes with source links and leaves a link behind (`/daily`) |
| Suggest vault improvements | Writes the *Vault Suggestions* checklist note: broken links, full inboxes, unlinked mentions, duplicates, orphans, stubs (`/garden`) |
| Rebuild semantic index | Re-embeds every note from scratch |
| Rebuild note gists | Regenerates the one-sentence gist of every note |
| Undo the agent's last change | Reverts the most recent approved write (diff-approved) |
| Undo every change from the agent's last message | Reverts that message's writes, newest first |

### How it works

The model gets twenty tools. Reading: `search_passages` (matching note *sections*, verbatim),
`search_notes`, `grep_vault` (grep every note for a string or regex, each match tagged with its
heading), `list_sections` (one heading surveyed across notes with size and first line, or which
sections contain which texts), `read_note`, `read_section`, `find_in_note`, `list_notes` (folder,
tag, name, size, modified dates), `list_files`, `read_file` (text of PDFs and text attachments),
`vault_overview`, `get_active_note`. Writing: `create_note`, `edit_note`, `edit_notes` (many edits
across notes in one call, one approval per note), `append_to_note`, `replace_section` (rewrite or
empty everything under a heading), `replace_note`, `move_note` (links are updated) and
`delete_file` (notes *or* attachments, to the trash). It calls
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

**Vault Suggestions.** *Suggest vault improvements* (`/garden`) needs no model: it reads the whole
vault and writes a checklist note with broken links, daily inboxes that filled up, notes whose
names appear in other notes without a wikilink, near-duplicate notes (by meaning, from the
semantic index), orphans and stubs. Each section says what to ask the agent to fix it ("Turn the
unlinked mentions in [[Vault Suggestions]] into wikilinks"). Run it again to refresh.

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

**Undo.** Every approved write is recorded with what it replaced. *Undo the agent's last change* and
*Undo every change from the agent's last message* are commands (also `/undo`, `/undo-all`), and each
tool card has an **Undo** button. A revert is shown as a diff and applied only when approved.

**Composer.** `@` picks a note to attach to your message (its content is included, so no tool call
is needed); `/` lists commands (`/reformat`, `/summarize`, `/undo`, `/undo-all`, `/new`, `/gists`,
`/index`, `/help`). The header has a **Copy conversation** button that copies the whole chat,
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

### Ollama from a different machine or on mobile

Set the Ollama URL to a LAN address (e.g. `http://192.168.1.10:11434`) and start Ollama with
`OLLAMA_HOST=0.0.0.0`. Modern Ollama already allows requests from Obsidian (`app://*`); if you
see a CORS/network error, set `OLLAMA_ORIGINS=app://obsidian.md*` on the Ollama server.

## Benchmarks

Every release is run through a scored benchmark: 20 scenarios on a generated 339-note vault
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

Run it yourself with `npm run make-vault && npm run e2e:large` (see Development); results land
in `bench/`.

## Privacy and network use

This plugin makes HTTP requests only to the Ollama URL you configure (default
`http://localhost:11434`). It sends your prompts and the contents of notes the agent reads to
that server. It never contacts any other host and collects no telemetry.

What it touches in your vault, and why:

- **Lists all notes** (`vault.getMarkdownFiles`) to search, index and let the agent browse. Folders in
  *Excluded folders* are skipped.
- **Reads notes** the agent chooses to open, and **writes** only after you approve a diff.
- **Writes to the clipboard** only when you click *Copy* on a reply. It never reads the clipboard.
- Stores the search index in the plugin's own folder inside your vault's config directory.

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

The benchmark (`scripts/e2e-large.ts`) runs 20 scenarios on a generated 339-note vault
(`scripts/make-vault.mjs`, with `scripts/large-facts.json` recording the facts the checks look
for) and saves per-scenario seconds, tool calls, errors, guessed paths, repeated calls and
pass/fail to `bench/<version>[-tag].json`. `MODEL=`, `NUM_CTX=`, `THINK=on|off`, `TEMPERATURE=`,
`PRESENCE=`, `GISTS=1`, `TAG=` and `ONLY=id,id` select what runs; `VAULT_DIR=` points it at a
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
