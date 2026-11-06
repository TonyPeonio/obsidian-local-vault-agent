import { App, MarkdownView, TFile, getAllTags, normalizePath } from "obsidian";
import type { FileInfo, NoteInfo, NoteMetadata, VaultAccess } from "./types";

/** `VaultAccess` backed by the live Obsidian app. */
export class ObsidianVault implements VaultAccess {
	constructor(
		private app: App,
		private isExcluded: (path: string) => boolean,
	) {}

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
		return this.fileFor(path) !== null;
	}

	async read(path: string): Promise<string> {
		const file = this.fileFor(path);
		if (!file) throw new Error(`Note not found: ${path}`);
		return this.app.vault.cachedRead(file);
	}

	async create(path: string, content: string): Promise<void> {
		const normalized = normalizePath(path);
		const folder = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
		if (folder && !this.app.vault.getFolderByPath(folder)) {
			// Create each missing ancestor in turn.
			const parts = folder.split("/");
			let current = "";
			for (const part of parts) {
				current = current ? `${current}/${part}` : part;
				if (!this.app.vault.getFolderByPath(current)) await this.app.vault.createFolder(current);
			}
		}
		await this.app.vault.create(normalized, content);
	}

	async modify(path: string, content: string): Promise<void> {
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
		const file = this.app.vault.getFileByPath(normalizePath(path)) ?? this.fileFor(path);
		if (!file) throw new Error(`File not found: ${path}`);
		// Honours the user's "Deleted files" preference (system trash / .trash / permanent).
		await this.app.fileManager.trashFile(file);
	}

	getMetadata(path: string): NoteMetadata {
		const file = this.fileFor(path);
		const empty: NoteMetadata = { tags: [], links: [], backlinks: [], headings: [], frontmatter: {} };
		if (!file) return empty;
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return empty;
		const tags = Array.from(new Set(getAllTags(cache) ?? []));
		const links = Array.from(
			new Set([...(cache.links ?? []), ...(cache.embeds ?? [])].map((l) => l.link)),
		);
		const headings = (cache.headings ?? []).map((h) => `${"#".repeat(h.level)} ${h.heading}`);
		const backlinks: string[] = [];
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const source of Object.keys(resolved)) {
			if (resolved[source][file.path]) backlinks.push(source);
		}
		const frontmatter: Record<string, unknown> = {};
		if (cache.frontmatter) {
			for (const [k, v] of Object.entries(cache.frontmatter)) {
				if (k !== "position") frontmatter[k] = v;
			}
		}
		return { tags, links, backlinks, headings, frontmatter };
	}

	getActiveNotePath(): string | null {
		const file = this.app.workspace.getActiveFile();
		return file && file.extension === "md" ? file.path : null;
	}

	getSelection(): string | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const sel = view?.editor?.getSelection();
		return sel && sel.length > 0 ? sel : null;
	}
}
