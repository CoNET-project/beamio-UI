/**
 * @jest-environment node
 */
/**
 * The page-to-worker first open (plan c): the SDK runner (client.ts runFirstOpenInWorker) talks to a fake worker over the same message
 * shapes as the real one. The fake worker runs the real worker command (worker/first-open.ts runFirstOpenCommand) with a fake environment.
 * The account signature goes through the host (signRequest / signResponse), as in the browser. No key ever comes back to the host.
 * SYNTHETIC values only.
 */
if (!(globalThis as { crypto?: unknown }).crypto) Object.defineProperty(globalThis, 'crypto', { value: require('crypto').webcrypto, configurable: true })
jest.mock('openpgp', () => ({ generateKey: async () => ({ privateKey: 'x', publicKey: 'x' }), readKey: async () => ({ getKeyIDs: () => [{ toHex: () => 'x' }, { toHex: () => 'abc' }] }) }))
// eslint-disable-next-line import/first
import { runFirstOpenInWorker } from '../../vendor/conet-chat-sdk/dist/client.js'
import type { FirstOpenEnv, ChainRecordRead } from '../../vendor/conet-chat-sdk/dist/worker/first-open.js'
import { legacySealCryptoKey } from './pgpBlobSealKey'
import { openLegacyPgpBlob } from './pgpBlob'

const ACCOUNT_KEY = '0x' + '11'.repeat(32)
let EOA = '0x' + 'd'.repeat(40)
let eoaSeq = 0
beforeEach(() => {
	eoaSeq += 1
	EOA = '0x' + eoaSeq.toString(16).padStart(40, '0')
})
const PRIV = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nSYNTH\n-----END PGP PRIVATE KEY BLOCK-----'
const NO_RECORD: ChainRecordRead = { lookup: { status: 'no_record' }, blob: 'missing' }

/** Shared fixtures for one test: the host signer, the registration POST, the RPC reads and the store (the worker's IndexedDB stand-in). */
function fixtures(over: { read?: () => Promise<ChainRecordRead>; post?: jest.Mock } = {}) {
	const store = new Map<string, unknown>()
	const post = over.post ?? jest.fn(async () => ({ status: 200, ok: true }))
	const generate = jest.fn(async (_eoa: string) => ({ keyID: 'K-SYNTH', privateKey: PRIV, publicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nP\n-----END PGP PUBLIC KEY BLOCK-----' }))
	const hostSign = jest.fn(async (req: { kind: string; message?: string }) => '0x' + 'cd'.repeat(65))
	const workers: FakeWorker[] = []
	return { store, post, generate, hostSign, workers, read: over.read ?? (async () => NO_RECORD) }
}

/**
 * A fake worker. `postMessage` runs the real command for a `firstOpen` message; the env's signMessage asks the host through a signRequest
 * message and waits for the matching signResponse, and the answer goes back as an ack (the same shapes as entry.ts).
 */
class FakeWorker {
	onmessage: ((ev: { data: unknown }) => void) | null = null
	onerror: (() => void) | null = null
	terminated = false
	private signWaiters = new Map<number, (sig: string | null) => void>()
	private seq = 1
	constructor(private readonly f: ReturnType<typeof fixtures>) {
		f.workers.push(this)
	}
	terminate() {
		this.terminated = true
	}
	private emit(data: unknown) {
		setTimeout(() => this.onmessage?.({ data }), 0)
	}
	postMessage(msg: { type: string; reqId?: number; request?: unknown; signature?: string; ok?: boolean }) {
		if (msg.type === 'signResponse') {
			const w = this.signWaiters.get(msg.reqId as number)
			this.signWaiters.delete(msg.reqId as number)
			w?.(msg.ok ? (msg.signature as string) : null)
			return
		}
		if (msg.type !== 'firstOpen') return
		const reqId = msg.reqId as number
		const request = msg.request as Parameters<typeof runFirstOpenCommand>[0]
		const env: FirstOpenEnv = {
			readRecord: () => this.f.read(),
			isRecorded: async () => true,
			store: { get: async (k) => this.f.store.get(k), set: async (k, v) => void this.f.store.set(k, v), delete: async (k) => void this.f.store.delete(k) },
			signMessage: (message) =>
				new Promise<string>((resolve, reject) => {
					const id = this.seq++
					this.signWaiters.set(id, (sig) => (sig ? resolve(sig) : reject(new Error('sign_refused'))))
					this.emit({ type: 'signRequest', reqId: id, request: { kind: 'eip191', message } })
				}),
			sealKey: request.sealKey,
			post: this.f.post,
			generateKeys: this.f.generate,
			now: () => 1_000_000,
			random: () => '0x' + '22'.repeat(16),
		}
		// a new worker instance for every command (the page ends it after each answer): a fresh module state, as in the browser (R93)
		let runFirstOpenCommand!: (r: FirstOpenRequestFixture, e: FirstOpenEnv) => Promise<unknown>
		jest.isolateModules(() => {
			runFirstOpenCommand = require('../../vendor/conet-chat-sdk/dist/worker/first-open.js').runFirstOpenCommand
		})
		runFirstOpenCommand(request, env).then(
			(result) => this.emit({ type: 'ack', reqId, ok: true, result }),
			(ex) => this.emit({ type: 'ack', reqId, ok: false, error: (ex as Error).message }),
		)
	}
}

type FirstOpenRequestFixture = { eoa: string; sealKey: CryptoKey; pgpManagerAddress: string; conetRpcUrl: string; chainId: number; apiBaseUrl: string; ruleVersion: string; localOldIdentity: boolean; currentMailbox: null; nodes: { domain: string; armoredPublicKey: string }[] }
const request = (sealKey: CryptoKey): FirstOpenRequestFixture => ({
	eoa: EOA,
	sealKey,
	pgpManagerAddress: '0x' + 'e'.repeat(40),
	conetRpcUrl: 'https://rpc.synth.invalid',
	chainId: 224422,
	apiBaseUrl: 'https://api.synth.invalid',
	ruleVersion: '0.53.25',
	localOldIdentity: false,
	currentMailbox: null,
	nodes: [{ domain: 'node-1.synth', armoredPublicKey: 'ARM-1' }],
})

describe('the page runs the first open in its own worker (plan c)', () => {
	it('a new account: the status and the key ID come back, the host signs the registration, the backup opens with the existing reader, the worker ends', async () => {
		const f = fixtures()
		const sealKey = await legacySealCryptoKey(ACCOUNT_KEY)
		const result = await runFirstOpenInWorker(() => new FakeWorker(f) as unknown as Worker, request(sealKey), f.hostSign, 5_000)
		expect(result).toEqual({ status: 'registering', keyID: 'K-SYNTH' })
		expect(Object.keys(result)).toEqual(['status', 'keyID'])
		expect(f.hostSign).toHaveBeenCalledTimes(1)
		expect(f.hostSign.mock.calls[0][0]).toEqual(expect.objectContaining({ kind: 'eip191' }))
		expect(f.post).toHaveBeenCalledTimes(1)
		const body = f.post.mock.calls[0][0] as { encrypKeyArmored: string }
		expect(await openLegacyPgpBlob(body.encrypKeyArmored, ACCOUNT_KEY)).toBe(PRIV)
		expect(f.workers[0].terminated).toBe(true)
	})

	it('an RPC failure on the record read is unknown: nothing is generated, nothing is registered, the page holds no key', async () => {
		const f = fixtures({ read: async () => { throw new Error('rpc down') } })
		const sealKey = await legacySealCryptoKey(ACCOUNT_KEY)
		const result = await runFirstOpenInWorker(() => new FakeWorker(f) as unknown as Worker, request(sealKey), f.hostSign, 5_000)
		expect(result.status).toBe('unknown')
		expect(f.generate).not.toHaveBeenCalled()
		expect(f.post).not.toHaveBeenCalled()
	})

	it('after a registration the chain shows the record: a second open generates nothing and sends nothing (one key, one registration)', async () => {
		const RECORD: ChainRecordRead = { lookup: { status: 'ok', publicArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nP\n-----END PGP PUBLIC KEY BLOCK-----', routersArmoreds: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nR\n-----END PGP PUBLIC KEY BLOCK-----', routePgpKeyID: 'r', userPgpKeyID: 'u' }, blob: 'present' }
		const f = fixtures()
		f.read = async () => (f.post.mock.calls.length > 0 ? RECORD : NO_RECORD)
		const sealKey = await legacySealCryptoKey(ACCOUNT_KEY)
		const first = await runFirstOpenInWorker(() => new FakeWorker(f) as unknown as Worker, request(sealKey), f.hostSign, 5_000)
		expect(first.status).toBe('registering')
		const again = await runFirstOpenInWorker(() => new FakeWorker(f) as unknown as Worker, request(sealKey), f.hostSign, 5_000)
		expect(again.status).toBe('ready')
		expect(f.generate).toHaveBeenCalledTimes(1)
		expect(f.post).toHaveBeenCalledTimes(1)
	})

	it('a timeout rejects and ends the worker', async () => {
		const f = fixtures()
		const sealKey = await legacySealCryptoKey(ACCOUNT_KEY)
		const silent = { postMessage() {}, terminate() { silent.terminated = true }, onmessage: null as null | ((e: unknown) => void), onerror: null as null | (() => void), terminated: false }
		await expect(runFirstOpenInWorker(() => silent as unknown as Worker, request(sealKey), f.hostSign, 20)).rejects.toThrow('first_open_timeout')
		expect(silent.terminated).toBe(true)
	})

	it('R93: three new worker instances in a row inside the hold: one registration; the hold lives in the store, per wallet', async () => {
		const f = fixtures()
		const sealKey = await legacySealCryptoKey(ACCOUNT_KEY)
		const a = await runFirstOpenInWorker(() => new FakeWorker(f) as unknown as Worker, request(sealKey), f.hostSign, 5_000)
		const b = await runFirstOpenInWorker(() => new FakeWorker(f) as unknown as Worker, request(sealKey), f.hostSign, 5_000)
		const c = await runFirstOpenInWorker(() => new FakeWorker(f) as unknown as Worker, request(sealKey), f.hostSign, 5_000)
		expect(a.status).toBe('registering')
		expect(b.status).toBe('pending_confirm')
		expect(c.status).toBe('pending_confirm')
		expect(f.generate).toHaveBeenCalledTimes(1)
		expect(f.post).toHaveBeenCalledTimes(1)
		expect([...f.store.keys()].some((k) => k.startsWith('firstOpen.hold.v1:'))).toBe(true)
	})
})
