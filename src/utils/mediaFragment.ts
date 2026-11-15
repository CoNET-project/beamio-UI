import { Unzip, UnzipInflate, unzipSync } from 'fflate'

/**
 * Chat media fragment helpers (download → decode → decrypt → unzip).
 *
 * The fragment server returns each encrypted voice/file payload as a base64
 * Data URL (about 27 MB of text for a 20 MB video). Decoding that with atob and
 * a byte loop blocked the main thread for 366 ms per 20 MB video on a desktop
 *  Pro (2026-11-11 harness; a phone is several times slower), and every
 * voice/video bubble started its download the moment a chat opened.
 *
 * The work now runs in a worker (src/workers/chatMedia). These functions are
 * the shared core, also used by the main-thread fallback.
 */

/** Characters decoded per slice in the main-thread fallback (multiple of 4). */
export const BASE64_SLICE_CHARS = 1 << 20
/** Compressed bytes fed to the streaming unzip per slice in the main-thread fallback. */
export const UNZIP_SLICE_BYTES = 256 * 1024

const yieldToUi = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function decodeBase64Slice(slice: string, out: Uint8Array, offset: number): number {
	const binary = atob(slice)
	for (let i = 0; i < binary.length; i += 1) out[offset + i] = binary.charCodeAt(i)
	return binary.length
}

/**
 * Base64 to bytes in slices. `yieldFn` runs between slices: the main-thread
 * fallback yields to the UI; the worker passes none.
 */
export async function decodeBase64InSlices(
	base64: string,
	sliceChars = BASE64_SLICE_CHARS,
	yieldFn: (() => Promise<void>) | null = yieldToUi,
): Promise<Uint8Array> {
	const clean = base64.replace(/\s+/g, '')
	const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
	const out = new Uint8Array(Math.max(0, Math.floor((clean.length * 3) / 4) - padding))
	const step = Math.max(4, sliceChars - (sliceChars % 4))
	let offset = 0
	for (let start = 0; start < clean.length; start += step) {
		offset += decodeBase64Slice(clean.slice(start, start + step), out, offset)
		if (yieldFn && start + step < clean.length) await yieldFn()
	}
	return offset === out.length ? out : out.subarray(0, offset)
}

/** Small base64 values (keys, IVs). */
export function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
	return bytes
}

/**
 * Cipher bytes of a fragment body. The server sends a Data URL as text; older
 * fragments may be raw bytes.
 */
export async function fragmentBodyToCipher(
	body: Blob,
	isText: boolean,
	yieldFn: (() => Promise<void>) | null,
): Promise<Uint8Array> {
	if (!isText) return new Uint8Array(await body.arrayBuffer())
	const text = (await body.text()).trim()
	if (!text.startsWith('data:')) return new TextEncoder().encode(text)
	const comma = text.indexOf(',')
	if (comma < 0) throw new Error('Invalid encrypted media payload')
	return decodeBase64InSlices(text.slice(comma + 1), BASE64_SLICE_CHARS, yieldFn)
}

export type FragmentResult =
	| { kind: 'plain'; plain: ArrayBuffer }
	| { kind: 'files'; files: Record<string, ArrayBuffer> }

/**
 * Unzip in slices with fflate's streaming Unzip, yielding between slices. Used
 * by the main-thread fallback: unzipSync of a 20 MB video archive was one long
 * task there.
 */
export async function unzipInSlices(
	bytes: Uint8Array,
	yieldFn: () => Promise<void>,
	sliceBytes = UNZIP_SLICE_BYTES,
): Promise<Record<string, Uint8Array>> {
	const parts: Record<string, Uint8Array[]> = {}
	const done: Record<string, Uint8Array> = {}
	let failure: unknown = null
	const unzipper = new Unzip(file => {
		const chunks: Uint8Array[] = []
		parts[file.name] = chunks
		file.ondata = (error, data, final) => {
			if (error) {
				failure = failure || error
				return
			}
			chunks.push(data)
			if (final) {
				const total = chunks.reduce((n, c) => n + c.length, 0)
				const out = new Uint8Array(total)
				let offset = 0
				for (const c of chunks) {
					out.set(c, offset)
					offset += c.length
				}
				done[file.name] = out
			}
		}
		file.start()
	})
	unzipper.register(UnzipInflate)
	for (let start = 0; start < bytes.length || start === 0; start += sliceBytes) {
		const end = Math.min(start + sliceBytes, bytes.length)
		unzipper.push(bytes.subarray(start, end), end >= bytes.length)
		if (failure) throw failure
		if (end >= bytes.length) break
		await yieldFn()
	}
	const names = Object.keys(parts)
	if (!names.length || names.some(name => !done[name])) throw new Error('Invalid or truncated media archive')
	return done
}

const toTransferable = (bytes: Uint8Array): ArrayBuffer =>
	bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? (bytes.buffer as ArrayBuffer)
		: (bytes.slice().buffer as ArrayBuffer)

/**
 * Decrypt (AES-GCM) and, for file messages, unzip. With `yieldFn` (main-thread
 * fallback) the unzip runs in slices; without it (worker) in one call.
 */
export async function decryptFragmentCipher(
	cipher: Uint8Array,
	keyB64: string,
	ivB64: string,
	unzip: boolean,
	yieldFn: (() => Promise<void>) | null = null,
): Promise<FragmentResult> {
	const key = await crypto.subtle.importKey('raw', base64ToBytes(keyB64), 'AES-GCM', false, ['decrypt'])
	const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(ivB64) }, key, cipher)
	if (!unzip) return { kind: 'plain', plain }
	const entries = yieldFn ? await unzipInSlices(new Uint8Array(plain), yieldFn) : unzipSync(new Uint8Array(plain))
	const files: Record<string, ArrayBuffer> = {}
	// Own buffer per entry so it can be transferred out of the worker.
	for (const [name, bytes] of Object.entries(entries)) files[name] = toTransferable(bytes)
	return { kind: 'files', files }
}

/**
 * At most `limit` media downloads at once. Opening a chat used to start one
 * download + decrypt per voice/video bubble at the same moment.
 */
export function createMediaQueue(limit: number) {
	let active = 0
	const waiting: Array<() => void> = []
	const next = () => {
		if (active >= limit) return
		const start = waiting.shift()
		if (start) start()
	}
	return function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const abortError = () => {
				const error = new Error('Aborted')
				error.name = 'AbortError'
				return error
			}
			if (signal?.aborted) {
				reject(abortError())
				return
			}
			const onAbort = () => {
				const index = waiting.indexOf(start)
				if (index >= 0) waiting.splice(index, 1)
				reject(abortError())
			}
			const start = () => {
				signal?.removeEventListener('abort', onAbort)
				active += 1
				task().then(resolve, reject).finally(() => {
					active -= 1
					next()
				})
			}
			signal?.addEventListener('abort', onAbort, { once: true })
			waiting.push(start)
			next()
		})
	}
}

/** Shared queue for chat voice and file downloads. */
export const runChatMediaTask = createMediaQueue(2)

/**
 * Identity of an encrypted media manifest. Chat rebuilds message objects on
 * every profile refresh (file manifests are decrypted again each time), so the
 * players must key their download on this string, not on the object.
 */
export function mediaManifestIdentity(manifest: { fragmentHash?: string; key?: string; iv?: string } | null | undefined): string {
	if (!manifest) return ''
	return `${manifest.fragmentHash || ''}|${manifest.key || ''}|${manifest.iv || ''}`
}
