/**
 * The automatic first open (constraints of iOS and Android on r2.5.20). A browser account is registered without a
 * click only when the existing restore judgement confirms a first identity AND both chain answers are definite. Unknown never enters the
 * flow; a malformed record is unknown; the pending key is its own store; single-flight per wallet; the key is saved before it is sent; the
 * chain is read again before the send; one attempt per run with a backoff. The effects are fakes. SYNTHETIC values only.
 */
import { autoFirstOpenDecision, chainBackupFromRead, chainReadFromLookup, classifyLocalIdentity, runAutoFirstOpen, withFirstOpenLock, type AutoFirstOpenDeps, type AutoFirstOpenInput, type LockManagerLike } from './autoFirstOpen'
import { classifyOwnPgp } from './pgpRestore'
import type { OwnChainRead } from './chatOwnRoutePlan'

const ARMOR = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nSYNTH\n-----END PGP PUBLIC KEY BLOCK-----'
const CLEAN: AutoFirstOpenInput = {
	restore: { kind: 'new_account' },
	chain: 'absent',
	chainBackup: 'absent',
	localOldIdentity: false,
	localPendingOwn: false,
}

/** chain[0] is the read the decision is made on; chain[1] is the read before the send. */
function fakes(chain: string[], over: Partial<AutoFirstOpenDeps> = {}, inputs: Partial<AutoFirstOpenInput> = {}) {
	const order: string[] = []
	let reads = 0
	const deps: AutoFirstOpenDeps = {
		readInputs: async () => (order.push('inputs'), { ...CLEAN, chain: chain[0] as never, ...inputs }),
		readChain: async () => (order.push('read'), chain[Math.min(++reads, chain.length - 1)] as never),
		registerWaitMs: () => 0,
		generateAndPersist: async () => (order.push('persist'), true),
		register: async () => (order.push('register'), true),
		recordRegister: () => order.push('recorded'),
		...over,
	}
	return { deps, order }
}

describe('decision table (restore judgement first, then the chain answers)', () => {
	it('a confirmed first identity, both chain answers definite and empty: generate and register', () => {
		expect(autoFirstOpenDecision(CLEAN)).toBe('generate_and_register')
	})

	it('a restore failure returns before anything else, even with an absent chain', () => {
		expect(autoFirstOpenDecision({ ...CLEAN, restore: { kind: 'failure', code: 'pgp_backup_missing' } })).toBe('keep_protection')
	})

	it('a read error of the restore judgement waits: an unknown is never a first identity', () => {
		expect(autoFirstOpenDecision({ ...CLEAN, restore: { kind: 'read_error', reason: 'rpc' } })).toBe('wait_unknown')
	})

	it('a restore judgement that is ok is the original path', () => {
		expect(autoFirstOpenDecision({ ...CLEAN, restore: { kind: 'ok' } })).toBe('use_record')
	})

	it('constraint 1: unknown chain, unknown backup, or a backup present/old identity keep the right protection', () => {
		expect(autoFirstOpenDecision({ ...CLEAN, chain: 'unknown' })).toBe('wait_unknown')
		expect(autoFirstOpenDecision({ ...CLEAN, chain: 'record' })).toBe('use_record')
		expect(autoFirstOpenDecision({ ...CLEAN, chainBackup: 'unknown' })).toBe('wait_unknown')
		expect(autoFirstOpenDecision({ ...CLEAN, chainBackup: 'present' })).toBe('keep_protection')
		expect(autoFirstOpenDecision({ ...CLEAN, localOldIdentity: true })).toBe('keep_protection')
	})

	it('constraint 2: a key this flow saved and did not register is continued on restart, never regenerated', () => {
		expect(autoFirstOpenDecision({ ...CLEAN, localPendingOwn: true })).toBe('resume_pending')
	})

	it('reuses the existing restore judgement (classifyOwnPgp): an empty read is a first identity, a missing backup a failure, a read error waits', () => {
		const empty: OwnChainRead = { status: 'empty' }
		const noBackup: OwnChainRead = { status: 'ok', userKeyID: '0x1', routeKeyID: '0x2', routeArmor: ARMOR, privateBlob: 'missing' }
		const err: OwnChainRead = { status: 'error', reason: 'timeout' }
		expect(autoFirstOpenDecision({ ...CLEAN, restore: classifyOwnPgp({ read: empty, localKeyID: '', hasLocalKey: false }) })).toBe('generate_and_register')
		expect(autoFirstOpenDecision({ ...CLEAN, restore: classifyOwnPgp({ read: noBackup, localKeyID: '', hasLocalKey: false }) })).toBe('keep_protection')
		expect(autoFirstOpenDecision({ ...CLEAN, restore: classifyOwnPgp({ read: err, localKeyID: '', hasLocalKey: false }) })).toBe('wait_unknown')
	})
})

describe('the chain answers in three states (constraint 1)', () => {
	it('a successful lookup with no record is absent; a failed or incomplete one is unknown', () => {
		expect(chainReadFromLookup({ status: 'no_record' })).toBe('absent')
		expect(chainReadFromLookup({ status: 'network_error', reason: 'timeout' })).toBe('unknown')
	})

	it('exists but the key cannot be read (malformed armor, or one armor only) is unknown, never absent', () => {
		expect(chainReadFromLookup({ status: 'ok', publicArmored: 'not-an-armor', routersArmoreds: ARMOR })).toBe('unknown')
		expect(chainReadFromLookup({ status: 'ok', publicArmored: ARMOR, routersArmoreds: 'garbage' })).toBe('unknown')
		expect(chainReadFromLookup({ status: 'ok', publicArmored: ARMOR, routersArmoreds: ARMOR })).toBe('record')
	})

	it('the backup: missing is absent; ok or undecryptable is present; an error is unknown (never absent)', () => {
		expect(chainBackupFromRead('missing')).toBe('absent')
		expect(chainBackupFromRead('ok')).toBe('present')
		expect(chainBackupFromRead('undecryptable')).toBe('present')
		expect(chainBackupFromRead('error')).toBe('unknown')
	})
})

describe('the run', () => {
	it('positive: a browser account with no record is registered without a click, saved before it is sent, and read again before the send', async () => {
		const { deps, order } = fakes(['absent', 'absent'])
		expect(await runAutoFirstOpen(deps)).toBe('registered')
		expect(order).toEqual(['inputs', 'persist', 'read', 'register', 'recorded'])
	})

	it('an existing record is never replaced: no key, no registration', async () => {
		const { deps, order } = fakes(['record'])
		expect(await runAutoFirstOpen(deps)).toBe('use_record')
		expect(order).not.toContain('persist')
		expect(order).not.toContain('register')
	})

	it('a restore failure never generates a key', async () => {
		const { deps, order } = fakes(['absent'], {}, { restore: { kind: 'failure', code: 'pgp_backup_undecryptable' } })
		expect(await runAutoFirstOpen(deps)).toBe('keep_protection')
		expect(order).not.toContain('persist')
		expect(order).not.toContain('register')
	})

	it('an unknown read never generates a key: it waits', async () => {
		const { deps, order } = fakes(['unknown'])
		expect(await runAutoFirstOpen(deps)).toBe('wait_unknown')
		expect(order).not.toContain('persist')
	})

	it('an unknown backup read never generates a key: it waits', async () => {
		const { deps, order } = fakes(['absent'], {}, { chainBackup: 'unknown' })
		expect(await runAutoFirstOpen(deps)).toBe('wait_unknown')
		expect(order).not.toContain('persist')
	})

	it('a record that appears between the decision and the send stops the run: nothing is sent', async () => {
		const { deps, order } = fakes(['absent', 'record'])
		expect(await runAutoFirstOpen(deps)).toBe('use_record')
		expect(order).not.toContain('register')
	})

	it('restart: the key saved earlier is continued, no new key is generated, and the registration is sent once', async () => {
		const { deps, order } = fakes(['absent', 'absent'], {}, { localPendingOwn: true })
		expect(await runAutoFirstOpen(deps)).toBe('registered')
		expect(order).not.toContain('persist')
		expect(order.filter((x) => x === 'register')).toHaveLength(1)
	})

	it('a failed save means nothing is sent', async () => {
		const { deps, order } = fakes(['absent'], { generateAndPersist: async () => (order.push('persist'), false) })
		expect(await runAutoFirstOpen(deps)).toBe('persist_failed')
		expect(order).not.toContain('register')
	})

	it('a refused registration (including a 4xx) is sent once: no immediate retry, no new key, the failure is recorded', async () => {
		let attempts = 0
		const { deps, order } = fakes(['absent', 'absent'], { register: async () => (attempts++, false) })
		expect(await runAutoFirstOpen(deps)).toBe('register_failed')
		expect(attempts).toBe(1)
		expect(order.filter((x) => x === 'persist')).toHaveLength(1)
		expect(order).toContain('recorded')
	})

	it('a backoff after an earlier failure: nothing is generated and nothing is sent', async () => {
		const { deps, order } = fakes(['absent'], { registerWaitMs: () => 60_000 })
		expect(await runAutoFirstOpen(deps)).toBe('backoff')
		expect(order).not.toContain('persist')
		expect(order).not.toContain('register')
	})
})

describe('single-flight per wallet', () => {
	it('two first opens of the same wallet at once: one holds the lock, the other is busy; one registration', async () => {
		const held = new Set<string>()
		const locks: LockManagerLike = {
			request: async (name, _options, cb) => {
				if (held.has(name)) return cb(null)
				held.add(name)
				try {
					return await cb({})
				} finally {
					held.delete(name)
				}
			},
		}
		let registrations = 0
		const slow = async () => {
			await new Promise((r) => setTimeout(r, 5))
			registrations++
			return 'registered'
		}
		const [a, b] = await Promise.all([withFirstOpenLock('0x' + '1'.repeat(40), slow, locks), withFirstOpenLock('0x' + '1'.repeat(40), slow, locks)])
		expect([a, b].filter((x) => x === 'busy')).toHaveLength(1)
		expect(registrations).toBe(1)
	})

	it('a different wallet is not blocked by the lock', async () => {
		const locks: LockManagerLike = { request: async (_n, _o, cb) => cb({}) }
		expect(await withFirstOpenLock('0x' + '2'.repeat(40), async () => 'ok', locks)).toBe('ok')
		expect(await withFirstOpenLock('0x' + '3'.repeat(40), async () => 'ok', locks)).toBe('ok')
	})
})

describe('the pending key is its own store (constraint 2)', () => {
	it('a pending key is never an old identity; an old identity is never pending', () => {
		expect(classifyLocalIdentity({ chatKeyComplete: false, chatKeyAutoGenerated: false, pendingKeyPresent: true })).toEqual({ localOldIdentity: false, localPendingOwn: true })
		expect(classifyLocalIdentity({ chatKeyComplete: true, chatKeyAutoGenerated: false, pendingKeyPresent: false })).toEqual({ localOldIdentity: true, localPendingOwn: false })
	})
})
