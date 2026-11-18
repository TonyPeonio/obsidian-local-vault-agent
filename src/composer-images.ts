import { IMAGE_EXTENSIONS } from "./embeds";
import { ATTACHED_OPENING } from "./mentions";

/**
 * Images pasted or dropped into the message box. The file is saved where Obsidian puts attachments
 * and read with the vision model, exactly as the agent's read_image tool would read it; what it
 * says travels with the message, so the model has the picture's content without a tool call.
 * Pure: the view and the plugin do the saving and the reading.
 */

/** Larger files are refused: a base64 copy of the image is sent to the model server. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Images per message: each is a separate call to the vision model, seconds apiece. */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** What the composer needs to know of a pasted or dropped file. */
export interface IncomingFile {
	name: string;
	/** MIME type as the clipboard or the drag reports it; may be empty. */
	type: string;
	size: number;
}

export type ImageCheck = { ok: true; extension: string } | { ok: false; reason: "not-image" | "unsupported" | "too-large" | "empty" };

const BY_TYPE: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp" };

/** Whether a file is an image the vision model can be sent (PNG, JPEG, WebP), and its extension. */
export function checkImage(file: IncomingFile): ImageCheck {
	const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
	const type = file.type.toLowerCase();
	const extension = BY_TYPE[type] ?? (IMAGE_EXTENSIONS.includes(fromName) && (type === "" || type.startsWith("image/")) ? fromName : "");
	if (!extension) return { ok: false, reason: type.startsWith("image/") || ["gif", "bmp", "svg", "heic", "heif", "tif", "tiff", "avif"].includes(fromName) ? "unsupported" : "not-image" };
	if (file.size === 0) return { ok: false, reason: "empty" };
	if (file.size > MAX_IMAGE_BYTES) return { ok: false, reason: "too-large" };
	return { ok: true, extension };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The file name to save under. A picture from the clipboard has no name of its own (browsers call
 * it "image.png"): it gets Obsidian's "Pasted image 20261117185501.png". A dropped file keeps its
 * name, without characters a vault path cannot hold. Obsidian then makes the name unique.
 */
export function attachmentName(file: IncomingFile, extension: string, now: Date): string {
	const base = file.name
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^[. ]+|[. ]+$/g, "");
	if (!base || /^image$/i.test(base)) {
		const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		return `Pasted image ${stamp}.${extension}`;
	}
	return `${base}.${extension}`;
}

/** An attached image and what the vision model read in it, or why it could not be read. */
export interface ReadImage {
	path: string;
	text?: string;
	error?: string;
}

// `ATTACHED_OPENING` starts the part of a message that the chat does not show (the same opening as
// attached notes, so a restored chat hides it too).

/**
 * The message with what was read in its images appended. `maxCharsEach` bounds one reading.
 */
export function withImages(message: string, images: readonly ReadImage[], maxCharsEach: number): string {
	if (images.length === 0) return message;
	const parts = images.map((img) => {
		if (img.text === undefined) return `--- Attached image: ${img.path} ---\n(It could not be read: ${img.error ?? "unknown error"}. Say so; do not guess what it shows.)`;
		const text = img.text.length > maxCharsEach ? `${img.text.slice(0, maxCharsEach)}\n[… truncated; call read_image with a question for the rest]` : img.text;
		return `--- Attached image: ${img.path} ---\n${text}`;
	});
	const many = images.length > 1;
	return `${message}${ATTACHED_OPENING} the following image${many ? "s" : ""} to this message. ${many ? "They were" : "It was"} saved in the vault at the path${many ? "s" : ""} given and already read with read_image: the text in ${many ? "each" : "it"} and a description follow. Do not read ${many ? "them" : "it"} again unless a detail you need is missing, and then pass a question.)\n\n${parts.join("\n\n")}`;
}
