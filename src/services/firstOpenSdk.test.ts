/**
 * @jest-environment node
 */
/**
 * The first open in the SDK (vendor/conet-chat-sdk/src/firstOpen.ts): one flow under one lock per wallet (R80 M1), the status enum for the page,
 * the 4xx refusal, the backoff, the restart reuse, the second tab. openpgp is mocked: the key generation is checked for its parameters only.
 * SYNTHETIC values only.
 */
import {
	chainBackupFromRead,
	chainReadFromLookup,
	classifyLocalIdentity,
	classifyRegisterStatus,
	firstOpenDecision,
	generatePgpKeyPair,
	isFirstOpenCandidate,
	restoreKindFromRead,
	runFirstOpen,
	type FirstOpenDeps,
	type FirstOpenInputs,
	type LockManagerLike,
	type PendingKey,
} from '../../vendor/conet-chat-sdk/dist/firstOpen.js'

// CRA resets jest.fn implementations before each test, so the openpgp stand-in records its calls in plain variables
const opengpgCalls: { generate: unknown[]; read: unknown[] } = { generate: [], read: [] }
jest.mock('openpgp', () => ({
	generateKey: async (opts: unknown) => {
		;(globalThis as { __opengpgCalls?: { generate: unknown[]; read: unknown[] } }).__opengpgCalls?.generate.push(opts)
		return { privateKey: 'SYNTH-PRIV', publicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nS\n-----END PGP PUBLIC KEY BLOCK-----' }
	},
	readKey: async () => {
		;(globalThis as { __opengpgCalls?: { generate: unknown[]; read: unknown[] } }).__opengpgCalls?.read.push(true)
		return { getKeyIDs: () => [{ toHex: () => 'x' }, { toHex: () => 'abcdef0123456789' }] }
	},
}))
;(globalThis as { __opengpgCalls?: { generate: unknown[]; read: unknown[] } }).__opengpgCalls = opengpgCalls

const EOA = '0x' + 'a'.repeat(40)
const ARMOR = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nS\n-----END PGP PUBLIC KEY BLOCK-----'
const CLEAN: FirstOpenInputs = { restore: 'new_account', chain: 'absent', chainBackup: 'absent', localOldIdentity: false, localPendingOwn: false }
const KEYS: PendingKey = { keyID: 'K1', privateKey: 'SYNTH-PRIV', publicKey: 'SYNTH-PUB' }

/** A shared world: the pending store, the chain answers, and the calls. Each call records its name. */
function world(opts: { chain?: string[]; register?: string[]; saveOk?: boolean; backoff?: number; refused?: boolean } = {}) {
	const calls: string[] = []
	const store: { pending: PendingKey | null; refused: boolean } = { pending: null, refused: opts.refused ?? false }
	const chain = opts.chain ?? ['absent', 'absent']
	const regs = opts.register ?? ['registered']
	let chainReads = 0
	let regIdx = 0
	const deps: FirstOpenDeps = {
		readInputs: async () => (calls.push('inputs'), { ...CLEAN, localPendingOwn: store.pending !== null }),
		readChain: async () => (calls.push('readChain'), chain[Math.min(chainReads++, chain.length - 1)] as never),
		loadPending: async () => (calls.push('loadPending'), store.pending),
		savePending: async (k) => (calls.push('save'), (opts.saveOk ?? true) ? ((store.pending = k), true) : false),
		clearPending: async () => (calls.push('clear'), (store.pending = null), true),
		generateKeys: async () => (calls.push('generate'), KEYS),
		register: async () => (calls.push('register'), regs[Math.min(regIdx++, regs.length - 1)] as never),
		refusedBefore: () => store.refused,
		markRefused: () => (calls.push('refused'), (store.refused = true)),
		recordFailure: () => calls.push('failure'),
		backoffMs: () => opts.backoff ?? 0,
	}
	return { deps, calls, store }
}

/** A lock that grants the first holder and answers busy to the others while it runs. */
function sharedLock(): LockManagerLike {
	const held = new Set<string>()
	return {
		request: async (name, _o, cb) => {
			if (held.has(name)) return cb(null)
			held.add(name)
			try {
				return await cb({})
			} finally {
				held.delete(name)
			}
		},
	}
}

describe('the decision and the readings (SDK)', () => {
	it('the decision table: a confirmed first identity generates; a record, an unknown, a protection or a pending copy each take their row', () => {
		expect(firstOpenDecision(CLEAN)).toBe('generate_and_register')
		expect(firstOpenDecision({ ...CLEAN, chain: 'record' })).toBe('use_record')
		expect(firstOpenDecision({ ...CLEAN, chain: 'unknown' })).toBe('wait_unknown')
		expect(firstOpenDecision({ ...CLEAN, restore: 'failure' })).toBe('keep_protection')
		expect(firstOpenDecision({ ...CLEAN, localOldIdentity: true })).toBe('keep_protection')
		expect(firstOpenDecision({ ...CLEAN, localPendingOwn: true })).toBe('resume_pending')
	})

	it('the restore judgement matches the page rules: an empty read is a first identity, a missing backup a failure, an error waits', () => {
		expect(restoreKindFromRead({ status: 'empty' })).toBe('new_account')
		expect(restoreKindFromRead({ status: 'ok', privateBlob: 'missing' })).toBe('failure')
		expect(restoreKindFromRead({ status: 'ok', privateBlob: 'undecryptable' })).toBe('failure')
		expect(restoreKindFromRead({ status: 'ok', privateBlob: 'ok' })).toBe('ok')
		expect(restoreKindFromRead({ status: 'error' })).toBe('read_error')
	})

	it('an armor that cannot be read is unknown, never absent; a failed lookup is unknown; a definite empty answer is absent', () => {
		expect(chainReadFromLookup({ status: 'no_record' })).toBe('absent')
		expect(chainReadFromLookup({ status: 'network_error' })).toBe('unknown')
		expect(chainReadFromLookup({ status: 'ok', publicArmored: 'garbage', routersArmoreds: ARMOR })).toBe('unknown')
		expect(chainReadFromLookup({ status: 'ok', publicArmored: ARMOR, routersArmoreds: ARMOR })).toBe('record')
		expect(chainBackupFromRead('error')).toBe('unknown')
	})

	it('the registration status class: 2xx registered; 4xx refused; 5xx and no answer retry', () => {
		expect(classifyRegisterStatus(200)).toBe('registered')
		expect(classifyRegisterStatus(409)).toBe('refused')
		expect(classifyRegisterStatus(503)).toBe('retry')
		expect(classifyRegisterStatus(null)).toBe('retry')
	})

	it('the claim gate reads only a confirmed first identity; a record or a protection is not a candidate; the old identity is kept apart', () => {
		expect(isFirstOpenCandidate(CLEAN)).toBe(true)
		expect(isFirstOpenCandidate({ ...CLEAN, chain: 'record' })).toBe(false)
		expect(isFirstOpenCandidate({ ...CLEAN, restore: 'failure' })).toBe(false)
		expect(classifyLocalIdentity({ chatKeyComplete: true, chatKeyAutoGenerated: false, pendingKeyPresent: false })).toEqual({ localOldIdentity: true, localPendingOwn: false })
	})

	it('the key pair is generated in the SDK with the page parameters (passphrase empty), and the key ID is the second key ID, upper case', async () => {
		opengpgCalls.generate.length = 0
		opengpgCalls.read.length = 0
		const pair = await generatePgpKeyPair(EOA)
		expect(pair.keyID).toBe('ABCDEF0123456789')
		expect(opengpgCalls.generate[0]).toEqual(expect.objectContaining({ type: 'ecc', curve: 'curve25519', passphrase: '', format: 'armored' }))
		expect(opengpgCalls.read).toHaveLength(1)
	})
})

describe('the whole flow under one lock (R80 M1)', () => {
	it('positive: generate, save, read the pending copy from the store, read the chain again, register once, clear; the status is registering', async () => {
		const { deps, calls } = world()
		const r = await runFirstOpen(EOA, deps, sharedLock())
		expect(r).toEqual({ status: 'registering', keyID: 'K1' })
		expect(calls).toEqual(['inputs', 'generate', 'save', 'loadPending', 'readChain', 'register'])
	})

	it('a second tab while the first runs: busy, so one key and one registration only; the second reports registering, not an error', async () => {
		const lock = sharedLock()
		const a = world()
		const b = world({ chain: ['absent', 'absent'] })
		const slow = { ...a.deps, generateKeys: async () => { a.calls.push('generate'); await new Promise((r) => setTimeout(r, 5)); return KEYS } }
		const [ra, rb] = await Promise.all([runFirstOpen(EOA, slow, lock), runFirstOpen(EOA, b.deps, lock)])
		expect(ra.status).toBe('registering')
		expect(rb.status).toBe('registering')
		expect(a.calls.filter((x) => x === 'generate')).toHaveLength(1)
		expect(a.calls.filter((x) => x === 'register')).toHaveLength(1)
		expect(b.calls).toEqual([])
	})

	it('a restart with the copy saved earlier: no new key; the saved copy is registered', async () => {
		const { deps, calls, store } = world()
		store.pending = KEYS
		const r = await runFirstOpen(EOA, deps, sharedLock())
		expect(r.status).toBe('registering')
		expect(calls).not.toContain('generate')
		expect(calls).toContain('register')
	})

	it('a record that appears before the send: nothing is sent, the pending copy is cleared, the status is ready', async () => {
		const { deps, calls, store } = world({ chain: ['record'] })
		const r = await runFirstOpen(EOA, deps, sharedLock())
		expect(r.status).toBe('ready')
		expect(calls).not.toContain('register')
		expect(store.pending).toBeNull()
	})

	it('an unknown read before the send is never absent: nothing is sent', async () => {
		const { deps, calls } = world({ chain: ['unknown'] })
		expect((await runFirstOpen(EOA, deps, sharedLock())).status).toBe('unknown')
		expect(calls).not.toContain('register')
	})

	it('a failed save means nothing is sent', async () => {
		const { deps, calls } = world({ saveOk: false })
		expect((await runFirstOpen(EOA, deps, sharedLock())).status).toBe('error')
		expect(calls).not.toContain('register')
	})

	it('a 4xx is a permanent refusal: sent once, marked on this device, and the next run sends nothing', async () => {
		const first = world({ register: ['refused'] })
		expect((await runFirstOpen(EOA, first.deps, sharedLock())).status).toBe('error')
		expect(first.calls.filter((x) => x === 'register')).toHaveLength(1)
		expect(first.calls).toContain('refused')
		const again = world({ refused: true })
		expect((await runFirstOpen(EOA, again.deps, sharedLock())).status).toBe('error')
		expect(again.calls).toEqual([])
	})

	it('a 5xx or no answer is retried with the backoff: the failure is recorded and the status is pending_confirm', async () => {
		const { deps, calls } = world({ register: ['retry'] })
		expect((await runFirstOpen(EOA, deps, sharedLock())).status).toBe('pending_confirm')
		expect(calls).toContain('failure')
	})

	it('inside the backoff nothing is generated and nothing is sent', async () => {
		const { deps, calls } = world({ backoff: 60_000 })
		expect((await runFirstOpen(EOA, deps, sharedLock())).status).toBe('pending_confirm')
		expect(calls).not.toContain('generate')
		expect(calls).not.toContain('register')
	})
})
