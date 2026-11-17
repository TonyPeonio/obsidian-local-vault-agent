import { toWav16k } from "./audio";

/**
 * Records from the microphone for the chat's mic button and hands back a 16 kHz mono WAV for
 * Lecture Companion's whisper server. The browser decodes whatever MediaRecorder produced.
 */
export class VoiceRecorder {
	private recorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private chunks: Blob[] = [];

	get recording(): boolean {
		return this.recorder !== null;
	}

	async start(): Promise<void> {
		if (this.recorder) return;
		this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		this.chunks = [];
		this.recorder = new MediaRecorder(this.stream);
		this.recorder.addEventListener("dataavailable", (e) => {
			if (e.data.size) this.chunks.push(e.data);
		});
		this.recorder.start();
	}

	/** Stops and returns the recording as WAV bytes (16 kHz, mono, 16-bit). */
	async stop(): Promise<ArrayBuffer> {
		const rec = this.recorder;
		if (!rec) throw new Error("Not recording.");
		const stopped = new Promise<void>((res) => rec.addEventListener("stop", () => res(), { once: true }));
		rec.stop();
		await stopped;
		this.release();
		const data = await new Blob(this.chunks).arrayBuffer();
		this.chunks = [];
		const ctx = new AudioContext();
		try {
			const audio = await ctx.decodeAudioData(data);
			const channels: Float32Array[] = [];
			for (let i = 0; i < audio.numberOfChannels; i++) channels.push(audio.getChannelData(i));
			return toWav16k(channels, audio.sampleRate);
		} finally {
			void ctx.close();
		}
	}

	cancel(): void {
		try {
			this.recorder?.stop();
		} catch {
			// already stopped
		}
		this.release();
		this.chunks = [];
	}

	private release(): void {
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = null;
		this.recorder = null;
	}
}
