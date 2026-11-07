# Local Vault Agent

A fully local, agentic AI assistant for [Obsidian](https://obsidian.md), powered by
[Ollama](https://ollama.com). Nothing leaves your machine.

Ask it questions and it **searches your notes** to answer them. Ask it to **compile a topic**
and it reads the relevant notes and writes a new one with citations. Ask it to **reformat or
edit a note** and it shows you a diff that you approve before anything is written.

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
   - 8 GB VRAM: `ollama pull qwen3.5:4b` or `qwen3:8b`
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

- **Context window (`num_ctx`)** — default 32768. Ollama's own default of 4096 is far too small
  for reading notes; if answers seem to ignore what the tools returned, this is usually why. Set
  `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` on the Ollama server: the KV cache
  halves with no visible quality loss. Measured on a 12 GB RTX 5070 with `qwen3.5:9b` (Q4_K_M)
  and those two settings: 32k → 8.1 GB used, 85 tok/s; 64k → 8.9 GB, 81 tok/s; 128k → ~9.6 GB,
  76 tok/s — all on the GPU. Everything the agent does scales with the window (vault outline,
  gists, tool-result budgets), so on a card like that 65536–98304 is the sweet spot. `qwen3:14b`
  needs ~9.3 GB for weights alone and tops out around 32k.
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

Every release is run through a scored benchmark: 16 scenarios on a generated 339-note vault
(questions across notes, enumeration, a clean-up over 40 lecture sections, moving finished
projects, processing 127 daily notes, acting on the Vault Suggestions note, editing a selection,
a note that does not exist, and the loop failures reported from real vaults). Each scenario is
timed and counted for tool calls, tool errors, guessed paths and repeated calls, and checked
against facts the generator recorded. 96 checks in all; the vault is restored after every run.

Version 0.5.0, 2026-11-07, RTX 5070 12 GB, Ollama 0.40, 32k context unless noted. Identical
runs differ by up to 2× in wall time, so each configuration was run twice where it mattered.

| Configuration | Checks | Seconds | Tool calls | Repeated calls |
|---|---:|---:|---:|---:|
| **qwen3.5:9b, defaults (thinking off, temp 0.6)** | **94, 92** | **232, 160** | 103, 61 | 0, 0 |
| qwen3.5:9b, 16k context | 93 | 170 | 67 | 0 |
| qwen3.5:9b, temperature 0.3, presence 0 | 93, 90 | 146, 263 | 61, 207 | 3, 3 |
| qwen3.5:9b, thinking on | 89 | 588 | 274 | 7 |
| qwen3.5:9b, thinking on, before the 0.5.0 fixes | 91, 90 | 801, 451 | 262, 108 | 1, 4 |
| qwen3:14b, thinking off | 82 | 521 | 66 | 0 |
| qwen3.5:35b-a3b, thinking on (56% in system RAM) | 84, 87 | 934, 1192 | 114, 260 | 0, 3 |
| 0.4.1 (71 checks, 9 scenarios then) | 66/71 | 397 | 198 | 4 |

What the numbers say:

- **Thinking off is the default** because it was as accurate and two to three times faster;
  with thinking on the model also repeated searches it had already run. The agent loop gives
  the model one step at a time, which is most of what thinking buys.
- **Temperature 0.6** stays: 0.3 was not more precise and looped more often.
- **16k context** loses almost nothing on this vault; 32k is the default because larger vaults
  need the room for outlines and results.
- **A bigger model does not help on a 12 GB card.** The 35B spilled into RAM, took twice as
  long and passed fewer checks. `qwen3:14b` (previous generation) sent 45 tool calls in one step
  and failed the daily-notes job entirely.
- The failures that remain are concentrated in one scenario, the clean-up across 40 lecture
  sections, where the model sometimes announces the batch edit and then emits nothing; the
  follow-through nudge added in 0.5.0 recovers one of the two cases.

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

The benchmark (`scripts/e2e-large.ts`) runs 16 scenarios on a generated 339-note vault
(`scripts/make-vault.mjs`, with `scripts/large-facts.json` recording the facts the checks look
for) and saves per-scenario seconds, tool calls, errors, guessed paths, repeated calls and
pass/fail to `bench/<version>[-tag].json`. `MODEL=`, `NUM_CTX=`, `THINK=on|off`, `TEMPERATURE=`,
`PRESENCE=`, `GISTS=1`, `TAG=` and `ONLY=id,id` select what runs. `npm run bench-matrix` runs
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
