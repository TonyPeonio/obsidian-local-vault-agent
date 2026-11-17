/** Image types sent to the vision model as they are (Ollama decodes PNG, JPEG and WebP). */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];

/** Images a note embeds (`![[pic.png]]`, `![[pic.png|300]]`, `![alt](pic.png)`), in order, deduplicated. */
export function imageEmbeds(content: string): string[] {
	const out: string[] = [];
	const add = (raw: string) => {
		let t = raw.trim();
		try {
			t = decodeURI(t);
		} catch {
			// keep as written
		}
		t = t.replace(/[#|].*$/, "").trim();
		const ext = /\.([a-z0-9]+)$/i.exec(t)?.[1]?.toLowerCase();
		if (t && ext && [...IMAGE_EXTENSIONS, "gif", "bmp", "svg"].includes(ext) && !out.includes(t)) out.push(t);
	};
	for (const m of content.matchAll(/!\[\[([^\]\n]+)\]\]/g)) add(m[1]);
	for (const m of content.matchAll(/!\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) if (!/^[a-z]+:\/\//i.test(m[1])) add(m[1]);
	return out;
}
