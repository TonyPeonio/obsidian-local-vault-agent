/**
 * Voice input: the microphone recording is decoded by the browser, mixed down to mono, resampled
 * to 16 kHz and encoded as a 16-bit PCM WAV, the format Lecture Companion's `transcribe` takes
 * (its whisper server's input). Pure: typed arrays in, bytes out.
 */

/** Average of the channels. */
export function downmix(channels: Float32Array[]): Float32Array {
	if (channels.length === 0) return new Float32Array(0);
	if (channels.length === 1) return channels[0];
	const n = Math.min(...channels.map((c) => c.length));
	const out = new Float32Array(n);
	for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
	return out;
}

/** Resample by averaging the source samples each output sample covers (or interpolating when upsampling). */
export function resample(samples: Float32Array, fromRate: number, toRate = 16000): Float32Array {
	if (fromRate === toRate || samples.length === 0) return samples;
	const ratio = fromRate / toRate;
	const n = Math.floor(samples.length / ratio);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const start = i * ratio;
		if (ratio > 1) {
			const a = Math.floor(start);
			const b = Math.min(samples.length, Math.floor(start + ratio));
			let sum = 0;
			for (let j = a; j < b; j++) sum += samples[j];
			out[i] = b > a ? sum / (b - a) : samples[a];
		} else {
			const a = Math.floor(start);
			const t = start - a;
			out[i] = samples[a] * (1 - t) + (samples[Math.min(a + 1, samples.length - 1)] ?? 0) * t;
		}
	}
	return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, rate = 16000): ArrayBuffer {
	const buf = new ArrayBuffer(44 + samples.length * 2);
	const v = new DataView(buf);
	const str = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
	};
	str(0, "RIFF");
	v.setUint32(4, 36 + samples.length * 2, true);
	str(8, "WAVE");
	str(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true); // PCM
	v.setUint16(22, 1, true); // mono
	v.setUint32(24, rate, true);
	v.setUint32(28, rate * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	str(36, "data");
	v.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return buf;
}

/** Decoded audio (as an AudioBuffer gives it) → 16 kHz mono WAV. */
export function toWav16k(channels: Float32Array[], sampleRate: number): ArrayBuffer {
	return encodeWav(resample(downmix(channels), sampleRate, 16000), 16000);
}
