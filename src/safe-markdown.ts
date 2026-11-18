/**
 * Keeps the rendering of a model's reply from touching the network.
 *
 * Obsidian renders markdown images and some HTML by loading them. A reply is the model's words,
 * and the model reads the user's notes and clipped pages: text in one of those can ask it to
 * "include this image", whose address then carries whatever the model was told to put in it, and
 * the moment the reply is drawn the address is fetched. Nothing a local assistant shows should
 * leave the machine unasked, so anything in a reply that would load a remote resource is turned
 * into a plain link (the user can still click it) or named and removed. Notes in the vault
 * (`![[embed]]`), data: images and ordinary links are untouched. Pure: no DOM, no Obsidian.
 */

const REMOTE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

function isRemote(url: string): boolean {
	const u = url.trim().replace(/^<|>$/g, "");
	return REMOTE.test(u) && !/^(?:app|capacitor|file):/i.test(u);
}

/** Runs `fn` on the text outside fenced and inline code, which is shown as written and loads nothing. */
function outsideCode(text: string, fn: (plain: string) => string): string {
	const parts = text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g);
	return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join("");
}

export function safeMarkdown(text: string): string {
	if (!/!\[|<\s*(?:img|iframe|audio|video|source|embed|object|script|link|style|picture|track|svg|base|meta|form)\b/i.test(text)) return text;
	return outsideCode(text, (plain) => {
		let out = plain;
		// ![alt](https://… "title") → [alt](https://…)
		out = out.replace(/!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g, (whole: string, alt: string, url: string) => {
			if (!isRemote(url)) return whole;
			return `[${alt.trim() || "image"}](${url.trim().replace(/^<|>$/g, "")})`;
		});
		// ![alt][ref] with a remote definition further down → [alt][ref]
		const remoteRefs = new Set(Array.from(out.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(\S+)/gm)).filter((m) => isRemote(m[2])).map((m) => m[1].toLowerCase()));
		if (remoteRefs.size) out = out.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (whole: string, alt: string, ref: string) => (remoteRefs.has((ref || alt).toLowerCase()) ? `[${alt || ref}][${ref}]` : whole));
		// HTML that loads something: media with a remote source become links; frames, scripts and the like are named and dropped.
		out = out.replace(/<\s*(img|audio|video|source|track|embed)\b([^>]*)>/gi, (whole: string, tag: string, attrs: string) => {
			const src = /\b(?:src|srcset|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
			const url = (src?.[1] ?? src?.[2] ?? src?.[3] ?? "").split(/[\s,]/)[0];
			if (!url || !isRemote(url)) return whole;
			return `[${tag.toLowerCase() === "img" ? "image" : tag.toLowerCase()}](${url})`;
		});
		out = out.replace(/<\s*(iframe|script|object|style|svg|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, (_whole: string, tag: string) => `*(${tag.toLowerCase()} removed)*`);
		out = out.replace(/<\s*(iframe|script|object|link|base|meta|style|svg|form)\b[^>]*\/?>/gi, (_whole: string, tag: string) => `*(${tag.toLowerCase()} removed)*`);
		return out;
	});
}
