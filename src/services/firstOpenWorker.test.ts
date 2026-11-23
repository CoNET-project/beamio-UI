/**
 * @jest-environment node
 */
/**
 * The worker-side first open (vendor/conet-chat-sdk/src/worker/first-open.ts, plan step b): the decision, the one-shot registration, the
 * refusal kept on the device, the backoff, the pending copy reused after a restart, the mailbox choice, the lock. Fake environment only:
 * no chain, no network, no real key generation. SYNTHETIC values. The backup seal is checked with the existing legacy reader.
 */
if (!(globalThis as { crypto?: unknown }).crypto) Object.defineProperty(globalThis, 'crypto', { value: require('crypto').webcrypto, configurable: true })
jest.mock('openpgp', () => ({ generateKey: async () => ({ privateKey: 'x', publicKey: 'x' }), readKey: async () => ({ getKeyIDs: () => [{ toHex: () => 'x' }, { toHex: () => 'abc' }] }) }))
// eslint-disable-next-line import/first
import { runFirstOpenCommand, type FirstOpenEnv, type ChainRecordRead } from '../../vendor/conet-chat-sdk/dist/worker/first-open.js'
import { legacySealCryptoKey } from './pgpBlobSealKey'
import { openLegacyPgpBlob } from './pgpBlob'
import type { FirstOpenRequest } from '../../vendor/conet-chat-sdk/dist/protocol.js'

let EOA = '0x' + 'a'.repeat(40)
/** The worker keeps its backoff per wallet for its life: every test gets its own wallet. */
let eoaSeq = 0
beforeEach(() => {
	eoaSeq += 1
	EOA = '0x' + eoaSeq.toString(16).padStart(40, '0')
})
const ACCOUNT_KEY = '0x' + '11'.repeat(32)
const NODE = { domain: 'node-1.synth', armoredPublicKey: 'NODE-ARMOR-1' }
const NO_RECORD: ChainRecordRead = { lookup: { status: 'no_record' }, blob: 'missing' }
const PGP_PRIV = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nSYNTH\n-----END PGP PRIVATE KEY BLOCK-----'

type World = { env: FirstOpenEnv; post: jest.Mock; generate: jest.Mock; store: Map<string, unknown>; sealKey: CryptoKey }

async function world(over: Partial<FirstOpenEnv> & { post?: jest.Mock } = {}): Promise<World> {
	const store = new Map<string, unknown>()
	const sealKey = await legacySealCryptoKey(ACCOUNT_KEY)
	const post = over.post ?? jest.fn(async () => ({ status: 200, ok: true }))
	const generate = jest.fn(async () => ({ keyID: 'KEYID1', privateKey: PGP_PRIV, publicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nP\n-----END PGP PUBLIC KEY BLOCK-----' }))
	const env: FirstOpenEnv = {
		readRecord: over.readRecord ?? (async () => NO_RECORD),
		isRecorded: over.isRecorded ?? (async () => true),
		store: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v), delete: async (k) => void store.delete(k) },
		signMessage: async () => '0x' + 'ab'.repeat(65),
		sealKey,
		post,
		generateKeys: over.generateKeys ?? (generate as never),
		now: over.now ?? (() => 1_000_000),
		random: () => '0x' + '22'.repeat(16),
	}
	return { env, post, generate, store, sealKey }
}

const request = (over: Partial<FirstOpenRequest> = {}): FirstOpenRequest => ({
	eoa: EOA,
	sealKey: null as never,
	pgpManagerAddress: '0x' + 'c'.repeat(40),
	conetRpcUrl: 'https://rpc.synth.invalid',
	chainId: 224422,
	apiBaseUrl: 'https://api.synth.invalid',
	ruleVersion: '0.53.24',
	localOldIdentity: false,
	currentMailbox: null,
	nodes: [NODE],
	...over,
})

describe('first open in the worker (b)', () => {
	it('a confirmed empty record: one key, one registration, the backup opens with the existing reader, the status is registering', async () => {
		const w = await world()
		const r = await runFirstOpenCommand(request(), w.env)
		expect(r).toEqual({ status: 'registering', keyID: 'KEYID1' })
		expect(w.generate).toHaveBeenCalledTimes(1)
		expect(w.post).toHaveBeenCalledTimes(1)
		const body = w.post.mock.calls[0][0] as { wallet: string; encrypKeyArmored: string; routeKeyID: string; signature: string }
		expect(body.routeKeyID).toBe(NODE.domain)
		expect(body.signature.startsWith('0x')).toBe(true)
		expect(await openLegacyPgpBlob(body.encrypKeyArmored, ACCOUNT_KEY)).toBe(PGP_PRIV)
		// R92: the pending copy is kept after an accepted registration until the chain shows the record
		expect(w.store.has('firstOpen.pending.v1:' + EOA.toLowerCase())).toBe(true)
	})

	it('R92: the chain shows the record late: the second open generates no second key and sends nothing; the copy is cleared once the record shows', async () => {
		let chainHasRecord = false
		const RECORD: ChainRecordRead = { lookup: { status: 'ok', publicArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nP\n-----END PGP PUBLIC KEY BLOCK-----', routersArmoreds: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nR\n-----END PGP PUBLIC KEY BLOCK-----', routePgpKeyID: 'r', userPgpKeyID: 'u' }, blob: 'present' }
		let t = 1_000_000
		const w = await world({ readRecord: async () => (chainHasRecord ? RECORD : NO_RECORD), now: () => t })
		const first = await runFirstOpenCommand(request(), w.env)
		expect(first.status).toBe('registering')
		// the chain still reads absent (relay delay): a retry in the hold window neither generates nor sends
		t += 5_000
		const retry = await runFirstOpenCommand(request(), w.env)
		expect(retry.status).toBe('pending_confirm')
		expect(w.generate).toHaveBeenCalledTimes(1)
		expect(w.post).toHaveBeenCalledTimes(1)
		expect(w.store.has('firstOpen.pending.v1:' + EOA.toLowerCase())).toBe(true)
		// the record appears: the copy is cleared, nothing more is sent
		chainHasRecord = true
		t += 120_000
		const done = await runFirstOpenCommand(request(), w.env)
		expect(done.status).toBe('ready')
		expect(w.post).toHaveBeenCalledTimes(1)
		expect(w.store.has('firstOpen.pending.v1:' + EOA.toLowerCase())).toBe(false)
	})

	it('an RPC failure on the record read is unknown: nothing is generated and nothing is sent', async () => {
		const w = await world({ readRecord: async () => { throw new Error('rpc down') } })
		const r = await runFirstOpenCommand(request(), w.env)
		expect(r.status).toBe('unknown')
		expect(w.generate).not.toHaveBeenCalled()
		expect(w.post).not.toHaveBeenCalled()
	})

	it('an existing record: ready, no key is generated', async () => {
		const w = await world({ readRecord: async () => ({ lookup: { status: 'ok', publicArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nP\n-----END PGP PUBLIC KEY BLOCK-----', routersArmoreds: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nR\n-----END PGP PUBLIC KEY BLOCK-----', routePgpKeyID: 'r', userPgpKeyID: 'u' }, blob: 'present' }) })
		const r = await runFirstOpenCommand(request(), w.env)
		expect(r.status).toBe('ready')
		expect(w.generate).not.toHaveBeenCalled()
		expect(w.post).not.toHaveBeenCalled()
	})

	it('an old identity on this device is kept: no new key', async () => {
		const w = await world()
		const r = await runFirstOpenCommand(request({ localOldIdentity: true }), w.env)
		expect(w.generate).not.toHaveBeenCalled()
		expect(w.post).not.toHaveBeenCalled()
		expect(r.status).not.toBe('registering')
	})

	it('a restart reuses the saved pending copy: no new key, the saved key is registered', async () => {
		const w = await world()
		w.store.set('firstOpen.pending.v1:' + EOA.toLowerCase(), { keyID: 'SAVED', privateKey: PGP_PRIV, publicKey: 'PUB' })
		const r = await runFirstOpenCommand(request(), w.env)
		expect(r).toEqual({ status: 'registering', keyID: 'SAVED' })
		expect(w.generate).not.toHaveBeenCalled()
		expect(w.post).toHaveBeenCalledTimes(1)
	})

	it('a 4xx is a refusal kept on the device: one send, status error, and the next run sends nothing', async () => {
		const w = await world({ post: jest.fn(async () => ({ status: 409, ok: false })) })
		const r1 = await runFirstOpenCommand(request(), w.env)
		expect(r1.status).toBe('error')
		expect(w.post).toHaveBeenCalledTimes(1)
		const w2 = await world({ post: jest.fn(async () => ({ status: 200, ok: true })) })
		w2.store.set('firstOpen.refused.v1:' + EOA.toLowerCase(), '4xx:0.53.24')
		const r2 = await runFirstOpenCommand(request(), w2.env)
		expect(r2.status).toBe('error')
		expect(w2.post).not.toHaveBeenCalled()
	})

	it('a 5xx or no answer waits with the backoff: pending_confirm, and nothing is sent again inside the backoff', async () => {
		let t = 1_000_000
		const post = jest.fn(async () => ({ status: 503, ok: false }))
		const w = await world({ post, now: () => t })
		const r1 = await runFirstOpenCommand(request(), w.env)
		expect(r1.status).toBe('pending_confirm')
		t += 1_000
		const r2 = await runFirstOpenCommand(request(), w.env)
		expect(r2.status).toBe('pending_confirm')
		expect(post).toHaveBeenCalledTimes(1)
	})

	it('no recorded node and no current mailbox: nothing is sent (the caller waits)', async () => {
		const w = await world({ isRecorded: async () => false })
		const r = await runFirstOpenCommand(request(), w.env)
		expect(w.post).not.toHaveBeenCalled()
		expect(r.status).toBe('pending_confirm')
	})

	it('a verified current mailbox is used without a node check', async () => {
		const isRecorded = jest.fn(async () => true)
		const w = await world({ isRecorded })
		// another wallet: the backoff of the earlier test (module state of the worker) belongs to its own wallet
		const other = '0x' + 'b'.repeat(40)
		await runFirstOpenCommand(request({ eoa: other, currentMailbox: { routeKeyID: 'cur.synth', routeArmor: 'CUR' } }), w.env)
		expect(isRecorded).not.toHaveBeenCalled()
		expect((w.post.mock.calls[0][0] as { routeKeyID: string }).routeKeyID).toBe('cur.synth')
	})
})
