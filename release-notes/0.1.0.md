First release of **Local Vault Agent**: a fully local, agentic AI assistant for Obsidian powered by Ollama.

- Agent loop over nine vault tools: search, read, list, overview, active note, create, edit, append, replace
- Every write to the vault is shown as a line diff for approval before it happens
- Semantic search with a local embedding model (default `nomic-embed-text`), incrementally kept in sync, fused with keyword search
- Sidebar chat with streaming, optional thinking display, tool-call cards, copy / insert-at-cursor
- Commands: open chat, ask about selection, reformat current note, summarize current note, rebuild index
- Works with any Ollama model that supports tool calling; defaults to `qwen3.5:9b`

Requirements: Ollama running locally, a tool-capable chat model, and (optionally) an embedding model. See the README.
