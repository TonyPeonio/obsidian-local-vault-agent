DRAFT for 0.9.0 (core half: search, the agent loop, tools, safety, benchmarks). Numbers marked (final run) are replaced when the closing benchmark is in. The chat's own changes are in NEXT-ui.md.

Search that finds the passage, one model call fewer per question, and a long list of things the agent can no longer get wrong.

**Search**
- **Passages are found by meaning and by words together.** Embeddings blur exactly what notes are full of: a name, an identifier, a number, a rare term. Every passage is now scored both ways (embeddings, and BM25 over the same chunks) and the scores are blended; a passage with every word of the question gets a bonus large enough to pass the best match by meaning alone. On a retrieval benchmark of 240 questions with known answers (new: `npm run bench:retrieval`, no chat model, seconds per run) the right passage is in the six returned for 99.2% of questions, up from 65.8%, and first for 92.9%, up from 58.8%.
- **A passage says which section it is from.** A note that repeats a heading (a "Summary" under every lecture date) used to return passages labelled "Lectures › Summary". Chunks now carry the path of headings above them ("2026-09-10 › Summary"), which is embedded with the text, shown to the model, and accepted by `read_section`. An index from an earlier version is brought up to date in the background: only sections whose path changed are embedded again.
- **A day named in words is found.** "September 10", "9/10", "yesterday", "last Tuesday", "this week" become the ISO days notes are named and headed by; most of the results are kept for the notes and sections of that day, ranked by the question's other words. Questions that name a lecture by its date went from 0 of 60 to 60 of 60.
- **`search_notes` uses the same ranking** (the note whose best passage matches): the right note first for 92.9% of questions, 57.9% before.
- **When the vault has nothing on it, the search says so.** A word of the question that appears in no note at all is named ("No note in the vault contains "wheels""), and with the default embedding model a weak best match is called weak.

**Speed**
- **The search is made before the model's first reply.** A question about the content of notes always begins with the same search, so the plugin makes it and hands the model the result as its own tool call: one model call fewer per question, and no answer "from memory" before a note has been seen. Requests to change notes, questions about the vault's structure, messages with a note attached and follow-ups that lean on the conversation go to the model as before. Setting: *Search before the first reply*.
- **The model is made ready while you type.** Focusing the chat box loads the model and has it read its instructions and the vault outline (setting: *Get the model ready while you type*).
- **A conversation's instructions are written once.** A note created between two messages, often by the agent itself, used to change the start of the next request, and everything was read again; the change now travels as one line with the message.
- **Long jobs stop re-reading themselves.** Over budget, the conversation is cut once and well below the limit, so the following steps only append; the budget is in the model's own token counts, not an estimate, so a full window no longer silently loses the start of the prompt; and the wrap-up request keeps what is cached.
- **Results the model reads are smaller where nothing is lost**: a survey of one heading across a folder is grouped (three or more lines, one or two, empty) and names empty sections instead of listing them.

**Things the agent can no longer get wrong**
- Answering the first question without searching ("I found this by searching…" with no tool call) is caught and sent back.
- A heading given to `list_sections` as a text to look for is read as the heading; this had cost 131 tool calls in one run.
- Tool results stay within their limit and keep their last words (paging markers, "N more", verdicts); `read_note` paging no longer skips text; long lines in `grep_vault` are cut around the match; a folder that does not exist is reported, not answered with "nothing found"; dates are the user's local dates; a model-written regular expression can no longer freeze the app.
- A result cut by the per-step budget can be asked for again; arguments that were not valid JSON get that answer, not "missing argument"; a reply cut at the length limit says so; one retry after a server hiccup; a turn never ends on nothing.
- Sources and paragraph citations are added only to the reply that ends the turn.
- The nightly job cannot see daily notes older than its start date, and every topic note it writes gets its Sources.

**Safety and privacy**
- **Excluded folders are a boundary.** Nothing in them can be read, written, created, moved in or out, or named as a backlink, and an excluded note that is open is not "the open note". Enforced in one place under every tool.
- **A change after a question is always shown.** If you asked a question and the model (or a note it read) wants to change something, the diff dialog opens even when changes are approved automatically.
- **Text the agent reads is material, not orders.** A benchmark scenario plants instructions in a clipped page; the 9B model ignored them in every run with or without the new rule, so the rule is a second line, not the first.

**OpenAI-compatible servers**
- The thinking setting now reaches the model on llama.cpp's server and vLLM, and llama.cpp's timings reach the progress line. (final run: tested against a real llama.cpp server for the first time)

**Benchmark**
- The first full runs of 0.8.0 on the RTX 5070: 143 of 149 checks (141 to 144 over five runs).
- This version, same 149 checks plus 8 for the injection scenario: (final run).
- New: results record which checks failed and the answers; repeated runs are summarised with median and spread; the characters the model must read are counted independently of the machine's load; four scenarios on awkward notes (a 39,000-character log, a table, two notes with one name, properties), one on open tasks, one on prompt injection; `bench:retrieval`, `bench:ttft`.

**Not verified** (final run)
