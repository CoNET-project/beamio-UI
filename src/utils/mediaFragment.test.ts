import { zipSync, unzipSync, strToU8 } from 'fflate'
import { webcrypto } from 'crypto'
import {
	createMediaQueue,
	decodeBase64InSlices,
	decryptFragmentCipher,
	fragmentBodyToCipher,
	mediaManifestIdentity,
	unzipInSlices,
} from './mediaFragment'

// jsdom here has no WebCrypto; use Node's (same API as the browser and the worker).
if (!(globalThis as any).crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })

// Synthetic bytes only.
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff)
const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64')

describe('decodeBase64InSlices', () => {
	it.each([0, 1, 2, 3, 4, 5, 1000, 4096, 100_001])('matches Buffer for %i bytes', async (n) => {
		const src = bytes(n)
		const out = await decodeBase64InSlices(b64(src), n > 10_000 ? 4096 : 16)
		expect(Buffer.from(out).equals(Buffer.from(src))).toBe(true)
	})

	it('yields to the event loop between slices (no single long task)', async () => {
		const yieldFn = jest.fn(async () => {})
		const src = bytes(3 * 64)
		const out = await decodeBase64InSlices(b64(src), 64, yieldFn) // 256 chars → 4 slices → 3 yields
		expect(yieldFn).toHaveBeenCalledTimes(3)
		expect(Buffer.from(out).equals(Buffer.from(src))).toBe(true)
	})
})

// jsdom's Blob lacks text()/arrayBuffer(); the worker gets a real Blob.
const fakeBlob = (body: { text?: string; bin?: Uint8Array }) => ({
	text: async () => body.text ?? '',
	arrayBuffer: async () => (body.bin ?? new Uint8Array()).slice().buffer,
}) as unknown as Blob

describe('fragmentBodyToCipher', () => {
	it('decodes a text Data URL (what the fragment server returns), padded with whitespace', async () => {
		const src = bytes(3001)
		const out = await fragmentBodyToCipher(fakeBlob({ text: ` data:application/octet-stream;base64,${b64(src)}\n` }), true, null)
		expect(Buffer.from(out).equals(Buffer.from(src))).toBe(true)
	})

	it('reads raw bytes', async () => {
		const src = bytes(300)
		const out = await fragmentBodyToCipher(fakeBlob({ bin: src }), false, null)
		expect(Buffer.from(out).equals(Buffer.from(src))).toBe(true)
	})

	it('rejects a broken Data URL', async () => {
		await expect(fragmentBodyToCipher(fakeBlob({ text: 'data:no-comma' }), true, null)).rejects.toThrow('Invalid encrypted media payload')
	})
})

describe('decryptFragmentCipher', () => {
	const encrypt = async (plain: Uint8Array) => {
		const raw = webcrypto.getRandomValues(new Uint8Array(32))
		const iv = webcrypto.getRandomValues(new Uint8Array(12))
		const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
		const cipher = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
		return { cipher, key: b64(raw), iv: b64(iv) }
	}

	it('decrypts a voice payload', async () => {
		const voice = bytes(4096)
		const e = await encrypt(voice)
		const r = await decryptFragmentCipher(e.cipher, e.key, e.iv, false)
		expect(r.kind).toBe('plain')
		expect(Buffer.from(new Uint8Array((r as any).plain)).equals(Buffer.from(voice))).toBe(true)
	})

	it('decrypts and unzips a video archive into transferable buffers', async () => {
		const clip = bytes(10_000)
		const e = await encrypt(zipSync({ 'clip.mp4': clip, 'preview.jpg': strToU8('jpeg') }))
		const r = await decryptFragmentCipher(e.cipher, e.key, e.iv, true)
		expect(r.kind).toBe('files')
		const files = (r as any).files as Record<string, ArrayBuffer>
		expect(Object.keys(files).sort()).toEqual(['clip.mp4', 'preview.jpg'])
		expect(Buffer.from(new Uint8Array(files['clip.mp4'])).equals(Buffer.from(clip))).toBe(true)
		expect(files['clip.mp4'].byteLength).toBe(clip.length)
	})

	it('fails on a wrong key (shown as unavailable, not a hang)', async () => {
		const e = await encrypt(bytes(64))
		const other = await encrypt(bytes(64))
		await expect(decryptFragmentCipher(e.cipher, other.key, e.iv, false)).rejects.toBeTruthy()
	})
})

describe('createMediaQueue', () => {
	const deferred = () => {
		let resolve!: () => void
		const promise = new Promise<void>(r => { resolve = r })
		return { promise, resolve }
	}
	const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

	it('runs at most two downloads at once, in order (chat open with 6 voice bubbles)', async () => {
		const run = createMediaQueue(2)
		let active = 0
		let peak = 0
		const gates = Array.from({ length: 6 }, deferred)
		const started: number[] = []
		const jobs = gates.map((gate, i) => run(async () => {
			active += 1
			peak = Math.max(peak, active)
			started.push(i)
			await gate.promise
			active -= 1
			return i
		}))
		await flush()
		expect(started).toEqual([0, 1])
		gates[0].resolve()
		await flush()
		expect(started).toEqual([0, 1, 2])
		gates.forEach(g => g.resolve())
		await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2, 3, 4, 5])
		expect(peak).toBe(2)
	})

	it('drops a waiting job when its bubble unmounts (abort)', async () => {
		const run = createMediaQueue(1)
		const gate = deferred()
		const first = run(() => gate.promise)
		const controller = new AbortController()
		const task = jest.fn(async () => 'never')
		const second = run(task, controller.signal)
		controller.abort()
		await expect(second).rejects.toMatchObject({ name: 'AbortError' })
		gate.resolve()
		await first
		await flush()
		expect(task).not.toHaveBeenCalled()
	})

	it('keeps going after a failed download', async () => {
		const run = createMediaQueue(1)
		const failed = run(async () => { throw new Error('404') })
		const ok = run(async () => 'ok')
		await expect(failed).rejects.toThrow('404')
		await expect(ok).resolves.toBe('ok')
	})
})

describe('mediaManifestIdentity', () => {
	it('is equal for copies of the same manifest and differs when the fragment changes', () => {
		const a = { fragmentHash: '0xaa', key: 'k', iv: 'i', name: 'x' }
		expect(mediaManifestIdentity({ ...a })).toBe(mediaManifestIdentity(a))
		expect(mediaManifestIdentity({ ...a, fragmentHash: '0xbb' })).not.toBe(mediaManifestIdentity(a))
		expect(mediaManifestIdentity(null)).toBe('')
	})
})

describe('unzipInSlices (main-thread fallback)', () => {
	const random = (n: number) => { const u = new Uint8Array(n); webcrypto.getRandomValues(u.subarray(0, Math.min(n, 65536))); for (let i = 65536; i < n; i += 65536) webcrypto.getRandomValues(u.subarray(i, Math.min(i + 65536, n))); return u }

	it('matches unzipSync and yields between slices (no single long unzip)', async () => {
		const clip = random(300_000)
		const zipped = zipSync({ 'clip.mp4': clip, 'preview.jpg': strToU8('jpeg') }, { level: 6 })
		const yieldFn = jest.fn(async () => {})
		const out = await unzipInSlices(zipped, yieldFn, 32 * 1024)
		const ref = unzipSync(zipped)
		expect(Object.keys(out).sort()).toEqual(Object.keys(ref).sort())
		expect(Buffer.from(out['clip.mp4']).equals(Buffer.from(ref['clip.mp4']))).toBe(true)
		expect(yieldFn.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(zipped.length / (32 * 1024)) - 1)
	})

	it('handles stored (level 0) and empty files', async () => {
		const zipped = zipSync({ 'a.bin': bytes(5000), 'empty.txt': new Uint8Array() }, { level: 0 })
		const out = await unzipInSlices(zipped, async () => {}, 1024)
		expect(out['a.bin'].length).toBe(5000)
		expect(out['empty.txt'].length).toBe(0)
	})

	it('rejects a truncated archive instead of hanging', async () => {
		const zipped = zipSync({ 'clip.mp4': bytes(50_000) }, { level: 0 })
		await expect(unzipInSlices(zipped.subarray(0, 20_000), async () => {}, 4096)).rejects.toBeTruthy()
	})

	it('decryptFragmentCipher uses the sliced unzip when given a yield function', async () => {
		const raw = webcrypto.getRandomValues(new Uint8Array(32))
		const iv = webcrypto.getRandomValues(new Uint8Array(12))
		const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
		const clip = bytes(100_000)
		const cipher = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, zipSync({ 'clip.mp4': clip })))
		const yieldFn = jest.fn(async () => {})
		const r = await decryptFragmentCipher(cipher, b64(raw), b64(iv), true, yieldFn)
		expect(r.kind).toBe('files')
		expect(Buffer.from(new Uint8Array((r as any).files['clip.mp4'])).equals(Buffer.from(clip))).toBe(true)
	})
})
