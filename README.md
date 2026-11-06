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
   - 12 GB VRAM (e.g. RTX 3060/4070/5070): `ollama pull qwen3.5:9b` (default) or `qwen3:14b`
   - 8 GB VRAM: `ollama pull qwen3:8b` or `llama3.1:8b`
   - 24 GB VRAM: `ollama pull qwen3:32b`
3. An embedding model for semantic search: `ollama pull nomic-embed-text` (274 MB).

The plugin checks all of this for you: **Settings → Local Vault Agent → Test connection**.

## Usage

Click the robot icon in the ribbon, or run the command **Local Vault Agent: Open chat**.

Things to try:

- *"What have I written about X?"*
- *"Summarize my notes on X from the last month."*
- *"Compile everything I know about X into a new note called 'X Summary' and cite the sources."*
- Open a messy note and run **Reformat the current note**.
- Select some text and run **Ask about the selected text**.

### Commands

| Command | What it does |
|---|---|
| Open chat | Opens the sidebar chat |
| Ask about the selected text | Opens the chat with your selection quoted, ready for a question |
| Reformat the current note | Asks the agent to tidy the open note into clean markdown (diff-approved) |
| Summarize the current note | Bullet-point summary of the open note |
| Rebuild semantic index | Re-embeds every note from scratch |
| Rebuild note gists | Regenerates the one-sentence gist of every note |
| Undo the agent's last change | Reverts the most recent approved write (diff-approved) |
| Undo every change from the agent's last message | Reverts that message's writes, newest first |

### How it works

The model gets eighteen tools. Reading: `search_passages` (matching note *sections*, verbatim),
`search_notes`, `grep_vault` (grep every note for a string or regex, with context lines),
`read_note`, `read_section`, `find_in_note`, `list_notes` (folder, tag, name, modified dates),
`list_files`, `read_file` (text of PDFs and text attachments), `vault_overview`,
`get_active_note`. Writing: `create_note`, `edit_note`, `edit_notes` (many edits across notes in one call, one
approval per note), `append_to_note`, `replace_note`, `move_note` (links are updated) and
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
- **Note gists** — on by default. The first pass over a large vault takes a few minutes of GPU
  time in the background; turn it off on a laptop that shares the GPU with other work.
- **Conventions note** — `AGENT.md` by default; *Create / open* writes a starter you can edit.
- **Thinking mode** — Qwen3 / DeepSeek-R1 style reasoning. "Auto" uses the model default. Turn it
  off for faster replies on simple questions.
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
npm run build   # type-check + Obsidian review lint + production bundle
```

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
