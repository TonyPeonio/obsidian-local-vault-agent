import { App, MarkdownView, TFile, getAllTags, normalizePath, type WorkspaceLeaf } from "obsidian";
import { pickEditorTarget, selectionIsInActiveNote, type EditorCandidate } from "./editor-target";
import { refusedByExclusion } from "./settings";
import type { FileInfo, NoteInfo, NoteMetadata, VaultAccess } from "./types";

/** What every refused operation on an excluded path says; it does not confirm that the path exists. */
export function excludedMessage(path: string): string {
	return `"${path}" is inside a folder that is excluded in the plugin's settings: the agent does not read, list, create or change anything there.`;
}

/**
 * `VaultAccess` backed by the live Obsidian app.
 *
 * The excluded folders are a boundary, enforced here and not only where notes are listed: a path
 * inside one cannot be read, written, created, moved into or out of, or trashed, is reported as not
 * existing, has no metadata, is never named as a backlink, and is not "the open note" even while
 * the user has it open. Tools above this layer cannot forget the rule, because no call gets through.
 */
export class ObsidianVault implements VaultAccess {
	constructor(
		private app: App,
		private isExcluded: (path: string) => boolean,
	) {}

	private guard(path: string): void {
		const normalized = normalizePath(path);
		if (refusedByExclusion(normalized, this.isExcluded)) throw new Error(excludedMessage(path));
	}

	listNotes(): NoteInfo[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => !this.isExcluded(f.path))
			.map((f) => ({
				path: f.path,
				basename: f.basename,
				folder: f.parent?.path === "/" ? "" : (f.parent?.path ?? ""),
				mtime: f.stat.mtime,
				ctime: f.stat.ctime,
				size: f.stat.size,
			}));
	}

	private fileFor(path: string): TFile | null {
		const normalized = normalizePath(path);
		const direct = this.app.vault.getFileByPath(normalized);
		if (direct) return direct;
		if (!/\.md$/i.test(normalized)) {
			const withExt = this.app.vault.getFileByPath(normalized + ".md");
			if (withExt) return withExt;
		}
		return null;
	}

	resolve(pathOrName: string): string | null {
		const cleaned = pathOrName.trim().replace(/\\/g, "/").replace(/^\[\[|\]\]$/g, "").replace(/^\/+/, "");
		if (!cleaned) return null;
		const direct = this.fileFor(cleaned);
		if (direct) return this.isExcluded(direct.path) ? null : direct.path;
		// Fall back to Obsidian's own link resolution (handles bare note names and aliases).
		const linkpath = cleaned.replace(/\.md$/i, "");
		const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, "");
		if (dest && dest.extension === "md" && !this.isExcluded(dest.path)) return dest.path;
		// Last resort: case-insensitive match on the basename.
		const lower = linkpath.toLowerCase();
		const match = this.app.vault
			.getMarkdownFiles()
			.find((f) => f.basename.toLowerCase() === lower || f.path.toLowerCase() === lower + ".md");
		return match && !this.isExcluded(match.path) ? match.path : null;
	}

	exists(path: string): boolean {
		const file = this.fileFor(path);
		return file !== null && !this.isExcluded(file.path);
	}

	async read(path: string): Promise<string> {
		this.guard(path);
		const file = this.fileFor(path);
		if (!file) throw new Error(`Note not found: ${path}`);
		return this.app.vault.cachedRead(file);
	}

	async create(path: string, content: string): Promise<void> {
		this.guard(path);
		const normalized = normalizePath(path);
		await this.ensureFolder(normalized);
		await this.app.vault.create(normalized, content);
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		this.guard(path);
		const file = this.app.vault.getFileByPath(normalizePath(path));
		if (!file) throw new Error(`File not found: ${path}`);
		return this.app.vault.readBinary(file);
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.guard(path);
		const normalized = normalizePath(path);
		await this.ensureFolder(normalized);
		await this.app.vault.createBinary(normalized, data);
	}

	async rename(path: string, newPath: string): Promise<void> {
		this.guard(path);
		this.guard(newPath);
		const file = this.app.vault.getFileByPath(normalizePath(path)) ?? this.fileFor(path);
		if (!file) throw new Error(`File not found: ${path}`);
		const target = normalizePath(newPath);
		await this.ensureFolder(target);
		// FileManager.renameFile rewrites links in other notes; Vault.rename would not.
		await this.app.fileManager.renameFile(file, target);
	}

	/** Creates each missing ancestor folder of `normalizedPath` in turn. */
	private async ensureFolder(normalizedPath: string): Promise<void> {
		const folder = normalizedPath.includes("/") ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) : "";
		if (!folder || this.app.vault.getFolderByPath(folder)) return;
		let current = "";
		for (const part of folder.split("/")) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getFolderByPath(current)) await this.app.vault.createFolder(current);
		}
	}

	async modify(path: string, content: string): Promise<void> {
		this.guard(path);
		const file = this.fileFor(path);
		if (!file) throw new Error(`Note not found: ${path}`);
		// `process` serialises against other writers; the content was approved as a whole,
		// so we replace rather than transform.
		await this.app.vault.process(file, () => content);
	}

	listAttachments(): FileInfo[] {
		return this.app.vault
			.getFiles()
			.filter((f) => f.extension.toLowerCase() !== "md" && !this.isExcluded(f.path))
			.map((f) => ({
				path: f.path,
				basename: f.basename,
				extension: f.extension.toLowerCase(),
				folder: f.parent?.path === "/" ? "" : (f.parent?.path ?? ""),
				mtime: f.stat.mtime,
				ctime: f.stat.ctime,
				size: f.stat.size,
			}));
	}

	resolveFile(path: string): string | null {
		const cleaned = path.trim().replace(/\\/g, "/").replace(/^!?\[\[|\]\]$/g, "").replace(/^\/+/, "");
		if (!cleaned) return null;
		const file = this.app.vault.getFileByPath(normalizePath(cleaned));
		if (file) return this.isExcluded(file.path) ? null : file.path;
		// Attachments are usually embedded by bare name; let Obsidian resolve that too.
		const dest = this.app.metadataCache.getFirstLinkpathDest(cleaned, "");
		return dest && !this.isExcluded(dest.path) ? dest.path : null;
	}

	async trash(path: string): Promise<void> {
		this.guard(path);
		const file = this.app.vault.getFileByPath(normalizePath(path)) ?? this.fileFor(path);
		if (!file) throw new Error(`File not found: ${path}`);
		// Honours the user's "Deleted files" preference (system trash / .trash / permanent).
		await this.app.fileManager.trashFile(file);
	}

	getMetadata(path: string): NoteMetadata {
		const file = this.fileFor(path);
		const empty: NoteMetadata = { tags: [], links: [], backlinks: [], headings: [], frontmatter: {} };
		if (!file || this.isExcluded(file.path)) return empty;
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return empty;
		const tags = Array.from(new Set(getAllTags(cache) ?? []));
		const links = Array.from(
			new Set([...(cache.links ?? []), ...(cache.embeds ?? [])].map((l) => l.link)),
		);
		const headings = (cache.headings ?? []).map((h) => `${"#".repeat(h.level)} ${h.heading}`);
		const backlinks = this.backlinksOf(file.path);
		const frontmatter: Record<string, unknown> = {};
		if (cache.frontmatter) {
			for (const [k, v] of Object.entries(cache.frontmatter)) {
				if (k !== "position") frontmatter[k] = v;
			}
		}
		return { tags, links, backlinks, headings, frontmatter };
	}

	private backlinkMap: Map<string, string[]> | null = null;
	private backlinkMapAt = 0;

	/**
	 * Notes linking to `path`, from a reverse map of Obsidian's resolved links that is rebuilt at most
	 * once a second. Scanning every note's links for each note asked about made anything that looks
	 * at the whole vault (the outline in the system prompt, the gardener) quadratic: seconds at 2,000
	 * notes, minutes at 50,000.
	 */
	private backlinksOf(path: string): string[] {
		const now = Date.now();
		if (!this.backlinkMap || now - this.backlinkMapAt > 1000) {
			const map = new Map<string, string[]>();
			const resolved = this.app.metadataCache.resolvedLinks;
			for (const source of Object.keys(resolved)) {
				// A note in an excluded folder is not named anywhere, not even as "links here".
				if (this.isExcluded(source)) continue;
				for (const target of Object.keys(resolved[source])) {
					const list = map.get(target);
					if (list) list.push(source);
					else map.set(target, [source]);
				}
			}
			this.backlinkMap = map;
			this.backlinkMapAt = now;
		}
		return this.backlinkMap.get(path)?.slice() ?? [];
	}

	getActiveNotePath(): string | null {
		const file = this.app.workspace.getActiveFile();
		return file && file.extension === "md" && !this.isExcluded(file.path) ? file.path : null;
	}

	getSelection(): string | null {
		// Asked for while the user is typing in the chat, so the focused view is the chat, not the note.
		const view = findEditorView(this.app);
		// It is reported together with the active note, so it has to be a selection in that note.
		if (!view || !selectionIsInActiveNote(view.file?.path ?? null, this.getActiveNotePath())) return null;
		// Text selected in an excluded note stays there.
		if (view.file && this.isExcluded(view.file.path)) return null;
		const sel = view.editor?.getSelection();
		return sel && sel.length > 0 ? sel : null;
	}
}

/**
 * The markdown editor the user means when they act from the chat panel: the focused one, else the
 * one they were last in, else one showing the active note (see `pickEditorTarget`).
 */
export function findEditorView(app: App): MarkdownView | null {
	const ws = app.workspace;
	const candidate = (leaf: WorkspaceLeaf | null): EditorCandidate<MarkdownView> | null => (leaf && leaf.view instanceof MarkdownView ? { view: leaf.view, path: leaf.view.file?.path ?? null } : null);
	const active = ws.getActiveFile();
	return pickEditorTarget({
		focused: ws.getActiveViewOfType(MarkdownView),
		recent: candidate(ws.getMostRecentLeaf()),
		open: ws.getLeavesOfType("markdown").map(candidate).filter((c): c is EditorCandidate<MarkdownView> => c !== null),
		activePath: active ? active.path : null,
	});
}
