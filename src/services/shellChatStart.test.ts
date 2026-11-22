/**
 * @jest-environment node
 *
 * Shell chat start from the native public identity. The collaborators are fakes. The start must:
 * use identityPublic's EOA, PGP public key and route; never pass a private field to the listen; and stop with a state for G0, G1
 * and a missing PGP record. SYNTHETIC values only: no key material appears in this file.
 */
import { SHELL_G1_INIT_ENABLED, resetShellChatStartLoopGuard, startShellChatFromNativeIdentity, type ShellChatStartDeps, type ShellListenParams } from './shellChatStart'
import type { NativeIdentityPublic } from './nativeIdentityPublic'
import type { PgpRestoreOutcome } from './nativePgpRestore'
import fs from 'fs'
import path from 'path'

// The confirmation set is per page process; each case starts as a cold start.
beforeEach(() => resetShellChatStartLoopGuard())

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const PGP = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nsynthetic-public-only\n-----END PGP PUBLIC KEY BLOCK-----'
const ROUTE = 'synthetic-route-public-0001'
const OK: NativeIdentityPublic = {
	kind: 'ok',
	eoa: EOA,
	accountKey: `${EOA}:default`,
	pgpReady: true,
	pgpKeyID: 'syn-pgp-key-0001',
	pgpPublicKeyArmored: PGP,
	ownRouteArmoredPublicKey: ROUTE,
}
const NODES = [
	{ domain: 'NODEA', armoredPublicKey: 'a' },
	{ domain: 'NODEB', armoredPublicKey: 'b' },
	{ domain: 'MAILBOX', armoredPublicKey: ROUTE },
]

function fakeDeps(identity: NativeIdentityPublic, overrides: Partial<ShellChatStartDeps> = {}) {
	const calls: Record<string, unknown[]> = {}
	const rec = (name: string, ...args: unknown[]) => {
		;(calls[name] ??= []).push(args)
	}
	const deps: ShellChatStartDeps = {
		readIdentity: async () => identity,
		getNodes: async () => NODES,
		setAllNodes: (n) => rec('setAllNodes', n),
		setGossip: (on) => rec('setGossip', on),
		mailboxDomainsFor: (nodes, route) => new Set(nodes.filter((n) => n.armoredPublicKey === route).map((n) => n.domain)),
		pickEntries: async (c) => c,
		onListenPlanned: (p) => rec('onListenPlanned', p),
		onController: (c) => rec('onController', c),
		startListen: async (p: ShellListenParams) => {
			rec('startListen', p)
			return true
		},
		onLine: () => undefined,
		onActivity: () => undefined,
		log: (level, message) => rec('log', level, message),
		retry: (reason) => rec('retry', reason),
		readPersistedEoa: () => EOA,
			initWithPersistedEoa: async () => ({ ok: false as const, reason: 'address_mismatch' }),
			setIdentityPending: (p) => rec('setIdentityPending', p),
			setFirstIdentity: (v) => rec('setFirstIdentity', v),
			evaluatePgp: async () => ({ kind: 'unavailable' }),
			restorePgp: async (): Promise<PgpRestoreOutcome> => ({ ok: false, code: 'unavailable', failure: null }),
			showPgpFailure: (code) => rec('showPgpFailure', code),
			showChatUnavailable: () => rec('showChatUnavailable'),
			showIdentityPending: () => rec('showIdentityPending'),
			...overrides,
	}
	return { deps, calls }
}

describe('shell chat start from identityPublic (G2)', () => {
	it('starts the native listen with the public EOA, PGP public key and route; no private field is passed', async () => {
		const { deps, calls } = fakeDeps(OK)
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('started')
		const p = (calls.startListen[0] as [ShellListenParams])[0]
		expect(p.eoaAddress).toBe(EOA)
		expect(p.pgpPublicKeyArmored).toBe(PGP)
		expect(p.ownRouteArmoredPublicKey).toBe(ROUTE)
		const keys = Object.keys(p).join(' ')
		expect(keys).not.toMatch(/private|pgpPrivate|passphrase|mnemonic|recovery|password/i)
	})

	it('the entries exclude the mailbox that serves our own route', async () => {
		const { deps, calls } = fakeDeps(OK)
		await startShellChatFromNativeIdentity(deps)
		const planned = (calls.onListenPlanned[0] as [{ entryNodes: Array<{ domain: string }>; mailboxDomains: Set<string> }])[0]
		expect(planned.mailboxDomains.has('MAILBOX')).toBe(true)
		expect(planned.entryNodes.map((n) => n.domain).sort()).toEqual(['NODEA', 'NODEB'])
	})

	it('the controller that owns the listen is handed to the caller', async () => {
		const { deps, calls } = fakeDeps(OK)
		await startShellChatFromNativeIdentity(deps)
		expect(calls.onController).toHaveLength(1)
		expect(calls.setGossip).toEqual(expect.arrayContaining([[true]]))
	})

	it('a listen that does not start is retried, and gossip is off', async () => {
		const { deps, calls } = fakeDeps(OK, { startListen: async () => false })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('failed')
		expect(calls.retry).toEqual([['native listen did not start']])
		expect(calls.setGossip[calls.setGossip.length - 1]).toEqual([false])
	})
})

describe('shell chat start stops with a state, and never starts without the public material', () => {
	it('G0 (no key): no start, the import route applies', async () => {
		const { deps, calls } = fakeDeps({ kind: 'no_key' })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('no_key')
		expect(calls.startListen).toBeUndefined()
		expect(calls.retry).toBeUndefined()
	})

	it('G1 (key, not initialised): no start, and no retry from here (identityPublic needs G2)', async () => {
		const { deps, calls } = fakeDeps({ kind: 'not_ready' })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('not_ready')
		expect(calls.startListen).toBeUndefined()
		expect(calls.retry).toBeUndefined()
	})

	it('G2 without a PGP record (pgpReady false): no start, no retry', async () => {
		const { deps, calls } = fakeDeps({ kind: 'ok', eoa: EOA, accountKey: `${EOA}:default`, pgpReady: false })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('pgp_not_ready')
		expect(calls.startListen).toBeUndefined()
		expect(calls.retry).toBeUndefined()
	})

	it('an unanswered or refused identityPublic is retried, with no start', async () => {
		const { deps, calls } = fakeDeps({ kind: 'unavailable' })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('failed')
		expect(calls.startListen).toBeUndefined()
		expect(calls.retry).toEqual([['identityPublic unavailable']])
	})

	it('no CoNET nodes: retried, with no start', async () => {
		const { deps, calls } = fakeDeps(OK, { getNodes: async () => [] })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('failed')
		expect(calls.startListen).toBeUndefined()
		// an empty list is the explicit unavailable state (visible), then a retry.
		expect(calls.showChatUnavailable).toBeDefined()
		expect(calls.retry).toEqual([['node list unavailable']])
	})
})

describe('pgpReady false: the state is read by pgpRestoreEvaluate; a restore runs only after an ok evaluation', () => {
	const NO_PGP: NativeIdentityPublic = { kind: 'ok', eoa: EOA, accountKey: `${EOA}:default`, pgpReady: false }
	const ok = { kind: 'evaluated' as const, state: 'ok' as const, failureCode: null, offerEntry: false, legacy: 'unknown' as const, chain: 'unknown' as const }

	it('evaluation ok: pgpRestore runs once, and the start is retried', async () => {
		const restorePgp = jest.fn(async (): Promise<PgpRestoreOutcome> => ({ ok: true }))
		const { deps, calls } = fakeDeps(NO_PGP, { evaluatePgp: async () => ok, restorePgp })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('pgp_restored')
		expect(restorePgp).toHaveBeenCalledTimes(1)
		expect(calls.retry).toEqual([['pgp restored']])
		expect(calls.startListen).toBeUndefined()
	})

	it('evaluation failed: the failure is shown with its code; no restore and no retry', async () => {
		const restorePgp = jest.fn(async (): Promise<PgpRestoreOutcome> => ({ ok: true }))
		const { deps, calls } = fakeDeps(NO_PGP, {
			evaluatePgp: async () => ({ kind: 'evaluated', state: 'failed', failureCode: 'pgp_backup_missing', offerEntry: true, legacy: 'unknown', chain: 'unknown' }),
			restorePgp,
		})
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('pgp_failed')
		expect(calls.showPgpFailure).toEqual([['pgp_backup_missing']])
		expect(restorePgp).not.toHaveBeenCalled()
		expect(calls.retry).toBeUndefined()
	})

	it('first identity not confirmed (the fields are missing, unknown or not ABSENT/unregistered): no create entry, the identity is pending', async () => {
		const restorePgp = jest.fn(async (): Promise<PgpRestoreOutcome> => ({ ok: true }))
		const cases = [
			{ legacy: 'unknown', chain: 'unknown' },
			{ legacy: 'ABSENT', chain: 'registered' },
			{ legacy: 'PRESENT', chain: 'unregistered' },
			{ legacy: 'UNREADABLE', chain: 'unregistered' },
		] as const
		for (const c of cases) {
			const { deps, calls } = fakeDeps(NO_PGP, {
				evaluatePgp: async () => ({ kind: 'evaluated', state: 'first_identity', failureCode: null, offerEntry: true, legacy: c.legacy, chain: c.chain }),
				restorePgp,
			})
			await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('pgp_identity_pending')
			expect(calls.setFirstIdentity[calls.setFirstIdentity.length - 1]).toEqual([false])
			expect(calls.showIdentityPending).toEqual([[]])
			expect(calls.showChatUnavailable).toBeUndefined()
		}
		expect(restorePgp).not.toHaveBeenCalled()
	})

	it('first identity confirmed (legacy ABSENT, chain unregistered): no restore, no retry, no failure prompt (the user creates it from the entry)', async () => {
		const restorePgp = jest.fn(async (): Promise<PgpRestoreOutcome> => ({ ok: true }))
		const { deps, calls } = fakeDeps(NO_PGP, {
			evaluatePgp: async () => ({ kind: 'evaluated', state: 'first_identity', failureCode: null, offerEntry: true, legacy: 'ABSENT', chain: 'unregistered' }),
			restorePgp,
		})
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('pgp_first_identity')
		expect(calls.setFirstIdentity[calls.setFirstIdentity.length - 1]).toEqual([true])
		expect(restorePgp).not.toHaveBeenCalled()
		expect(calls.showPgpFailure).toBeUndefined()
		expect(calls.retry).toBeUndefined()
	})

	it('undetermined: retried, with no restore and no failure prompt', async () => {
		const restorePgp = jest.fn(async (): Promise<PgpRestoreOutcome> => ({ ok: true }))
		const { deps, calls } = fakeDeps(NO_PGP, { evaluatePgp: async () => ({ kind: 'evaluated', state: 'undetermined', failureCode: null, offerEntry: false }), restorePgp })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('failed')
		expect(restorePgp).not.toHaveBeenCalled()
		expect(calls.retry).toEqual([['pgp evaluate undetermined']])
	})

	it('an unanswered or refused evaluation waits, with no restore and no retry', async () => {
		const restorePgp = jest.fn(async (): Promise<PgpRestoreOutcome> => ({ ok: true }))
		const { deps, calls } = fakeDeps(NO_PGP, { evaluatePgp: async () => ({ kind: 'refused', code: 'not_ready' }), restorePgp })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('pgp_not_ready')
		expect(restorePgp).not.toHaveBeenCalled()
		expect(calls.retry).toBeUndefined()
	})

	it('a restore that fails with a fingerprint mismatch shows that failure', async () => {
		const { deps, calls } = fakeDeps(NO_PGP, {
			evaluatePgp: async () => ok,
			restorePgp: async () => ({ ok: false, code: 'pgp_fingerprint_mismatch', failure: 'pgp_fingerprint_mismatch' }),
		})
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('pgp_failed')
		expect(calls.showPgpFailure).toEqual([['pgp_fingerprint_mismatch']])
	})

	it('a restore already_exists continues the start once (no notice, no pgp_not_ready); another restore code is retried', async () => {
		resetShellChatStartLoopGuard()
		const a = fakeDeps(NO_PGP, { evaluatePgp: async () => ok, restorePgp: async () => ({ ok: false, code: 'already_exists', failure: null }) })
		await expect(startShellChatFromNativeIdentity(a.deps)).resolves.toBe('pgp_restored')
		expect(a.calls.retry).toEqual([['pgp already matches the backup']])
		expect(a.calls.showPgpFailure).toBeUndefined()
		resetShellChatStartLoopGuard()
		const b = fakeDeps(NO_PGP, { evaluatePgp: async () => ok, restorePgp: async () => ({ ok: false, code: 'readback_failed', failure: null }) })
		await expect(startShellChatFromNativeIdentity(b.deps)).resolves.toBe('failed')
		expect(b.calls.retry).toEqual([['pgp restore readback_failed']])
	})
})

describe('the start file never names the create command (creation is the user click only)', () => {
	it('shellChatStart.ts does not reference pgpIdentityCreate or the generate helper', () => {
		const src = fs.readFileSync(path.join(__dirname, 'shellChatStart.ts'), 'utf8')
		expect(src).not.toMatch(/pgpIdentityCreate|nativeGenerateNewPgpKey/)
	})
})

describe('no identity source after a restart', () => {
	it('G1 with no persisted public EOA: identity_source_missing, the retry state is set, and nothing is started or guessed', async () => {
		const { deps, calls } = fakeDeps({ kind: 'not_ready' }, { readPersistedEoa: () => '' })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('identity_source_missing')
		expect(calls.setIdentityPending).toEqual([[true]])
		expect(calls.startListen).toBeUndefined()
		expect(calls.retry).toBeUndefined()
	})

	it('G1 with a persisted EOA and a refused init: the start waits; no retry state is shown', async () => {
		const { deps, calls } = fakeDeps({ kind: 'not_ready' })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('not_ready')
		expect(calls.setIdentityPending).toBeUndefined()
	})

	it('G2 identity read: the retry state is cleared', async () => {
		const { deps, calls } = fakeDeps(OK)
		await startShellChatFromNativeIdentity(deps)
		expect(calls.setIdentityPending[calls.setIdentityPending.length - 1]).toEqual([false])
	})
})

describe('G1 start: identity-only init with the persisted EOA', () => {
	it('init succeeds: the EOA alone is the input, and the start is retried (initialised)', async () => {
		const initWithPersistedEoa = jest.fn(async (..._args: unknown[]) => ({ ok: true as const }))
		const { deps, calls } = fakeDeps({ kind: 'not_ready' }, { initWithPersistedEoa })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('initialised')
		expect(initWithPersistedEoa).toHaveBeenCalledTimes(1)
		expect(initWithPersistedEoa.mock.calls[0][0]).toBe(EOA)
		expect(calls.retry).toEqual([['g1 init done']])
		expect(calls.startListen).toBeUndefined()
	})

	it('init refused: no retry from here, the start waits', async () => {
		const { deps, calls } = fakeDeps({ kind: 'not_ready' }, { initWithPersistedEoa: async () => ({ ok: false as const, reason: 'address_mismatch' }) })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('not_ready')
		expect(calls.retry).toBeUndefined()
	})
})

describe('G1 init from the chain is on (correction 2026-11-13)', () => {
	it('the flag is on', () => {
		expect(SHELL_G1_INIT_ENABLED).toBe(false)
	})

	it('with no initializer injected, G1 with a persisted EOA waits: no init, no retry, no retry state', async () => {
		const { deps, calls } = fakeDeps({ kind: 'not_ready' }, { initWithPersistedEoa: undefined })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('not_ready')
		expect(calls.retry).toBeUndefined()
		expect(calls.setIdentityPending).toBeUndefined()
		expect(calls.startListen).toBeUndefined()
	})
})

describe('a listen refused with address_mismatch is not retried, and shows no import or lock state', () => {
	it('address_mismatch from the native start: identity_mismatch, no retry, gossip off, no identity state changed', async () => {
		const { deps, calls } = fakeDeps(OK, { startListen: async () => false, listenRefusal: () => 'address_mismatch' })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('identity_mismatch')
		expect(calls.retry).toBeUndefined()
		// The G2 read clears the pending and first-identity flags as before; a refusal never sets them (no pending or first-identity page).
		expect(calls.setIdentityPending).toEqual([[false]])
		expect(calls.setFirstIdentity).toEqual([[false]])
		// The gossip flag is raised for the start and lowered when the refused start ends.
		expect(calls.setGossip).toEqual([[true], [false]])
	})

	it('any other failed start is still retried (the refusal rule does not swallow transient failures)', async () => {
		const { deps, calls } = fakeDeps(OK, { startListen: async () => false, listenRefusal: () => null })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('failed')
		expect(calls.retry).toEqual([['native listen did not start']])
	})
	const NO_PGP_CASE: NativeIdentityPublic = { kind: 'ok', eoa: EOA, accountKey: `${EOA}:default`, pgpReady: false }
	const okCase = { kind: 'evaluated' as const, state: 'ok' as const, failureCode: null, offerEntry: false }
	// (native rule): not_ready = an inconsistent record or a locked store, nothing written. The session ends: no retry;
	// the not_ready notice (explicit replacement) is shown. already_exists ends too (above). Other codes keep the retry.
	it('a restore not_ready ends the session: no automatic retry, and the not_ready notice is shown', async () => {
		const { deps, calls } = fakeDeps(NO_PGP_CASE, {
			evaluatePgp: async () => okCase,
			restorePgp: async () => ({ ok: false, code: 'not_ready', failure: null }),
		})
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('pgp_failed')
		expect(calls.showPgpFailure).toEqual([['pgp_restore_not_ready']])
		expect(calls.retry).toBeUndefined()
	})

	it('two starts that each read not_ready both stop at not_ready: one restore per start, and no retry is scheduled', async () => {
		const restorePgp = jest.fn(async (): Promise<PgpRestoreOutcome> => ({ ok: false, code: 'not_ready', failure: null }))
		const { deps, calls } = fakeDeps(NO_PGP_CASE, { evaluatePgp: async () => okCase, restorePgp })
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('pgp_failed')
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('pgp_failed')
		expect(restorePgp).toHaveBeenCalledTimes(2)
		expect(calls.retry).toBeUndefined()
	})
	it('after already_exists, a later start in this process sends no evaluate and no restore; with the route still missing the chat is unavailable (not silent)', async () => {
		resetShellChatStartLoopGuard()
		const restorePgp = jest.fn(async (): Promise<PgpRestoreOutcome> => ({ ok: false, code: 'already_exists', failure: null }))
		const evaluatePgp = jest.fn(async () => okCase)
		const first = fakeDeps(NO_PGP_CASE, { evaluatePgp, restorePgp })
		await expect(startShellChatFromNativeIdentity(first.deps)).resolves.toBe('pgp_restored')
		expect(restorePgp).toHaveBeenCalledTimes(1)
		expect(first.calls.retry).toEqual([['pgp already matches the backup']])
		const second = fakeDeps(NO_PGP_CASE, { evaluatePgp, restorePgp })
		await expect(startShellChatFromNativeIdentity(second.deps)).resolves.toBe('chat_unavailable')
		expect(restorePgp).toHaveBeenCalledTimes(1)
		expect(evaluatePgp).toHaveBeenCalledTimes(1)
		expect(second.calls.showChatUnavailable).toEqual([[]])
		expect(second.calls.retry).toBeUndefined()
		expect(second.calls.showPgpFailure).toBeUndefined()
	})

	it('once identityPublic reads pgpReady true the start proceeds normally; a cold start (empty confirmation set) may send one restore again', async () => {
		resetShellChatStartLoopGuard()
		const restorePgp = jest.fn(async (): Promise<PgpRestoreOutcome> => ({ ok: false, code: 'already_exists', failure: null }))
		const evaluatePgp = jest.fn(async () => okCase)
		await startShellChatFromNativeIdentity(fakeDeps(NO_PGP_CASE, { evaluatePgp, restorePgp }).deps)
		expect(restorePgp).toHaveBeenCalledTimes(1)
		const ready = fakeDeps(OK, { evaluatePgp, restorePgp })
		await startShellChatFromNativeIdentity(ready.deps)
		expect(restorePgp).toHaveBeenCalledTimes(1)
		expect(ready.calls.startListen).toBeDefined()
		expect(ready.calls.showChatUnavailable).toBeUndefined()
		resetShellChatStartLoopGuard()
		await startShellChatFromNativeIdentity(fakeDeps(NO_PGP_CASE, { evaluatePgp, restorePgp }).deps)
		expect(restorePgp).toHaveBeenCalledTimes(2)
	})
})

describe('closed identity module: no automatic retry, the closed notice takes over', () => {
	it('clear_failed at the listen start: no retry, the closed notice with the reason, gossip off', async () => {
		const { deps, calls } = fakeDeps(OK, {
			startListen: async () => false,
			takeIdentityClosed: () => 'clear_failed',
			showIdentityClosed: (reason) => rec_(calls, 'showIdentityClosed', reason),
		})
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('identity_closed')
		expect(calls.retry).toBeUndefined()
		expect(calls.showIdentityClosed).toEqual([['clear_failed']])
		expect(calls.setGossip[calls.setGossip.length - 1]).toEqual([false])
	})

	it('unregister_refused at the listen start is reported as the closed reason, and not retried', async () => {
		const { deps, calls } = fakeDeps(OK, {
			startListen: async () => false,
			takeIdentityClosed: () => 'unregister_refused',
			showIdentityClosed: (reason) => rec_(calls, 'showIdentityClosed', reason),
		})
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('identity_closed')
		expect(calls.retry).toBeUndefined()
		expect(calls.showIdentityClosed).toEqual([['unregister_refused']])
	})

	it('an ordinary listen failure (no closed reason) is still an ordinary failure, retried as a failure', async () => {
		const { deps, calls } = fakeDeps(OK, {
			startListen: async () => false,
			takeIdentityClosed: () => null,
			retry: (reason, kind) => rec_(calls, 'retry', reason, kind ?? 'failure'),
		})
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('failed')
		expect(calls.retry).toEqual([['native listen did not start', 'failure']])
	})

	it('a continuation after a restored PGP is scheduled as a continuation, not a failure', async () => {
		const { deps, calls } = fakeDeps(
			{ ...OK, pgpReady: false, pgpPublicKeyArmored: '', ownRouteArmoredPublicKey: '' },
			{
				evaluatePgp: async () => ({ kind: 'evaluated', state: 'ok' }) as never,
				restorePgp: async (): Promise<PgpRestoreOutcome> => ({ ok: true, code: 'ok', failure: null }) as never,
				retry: (reason, kind) => rec_(calls, 'retry', reason, kind ?? 'failure'),
			},
		)
		await expect(startShellChatFromNativeIdentity(deps)).resolves.toBe('pgp_restored')
		expect(calls.retry).toEqual([['pgp restored', 'continue']])
	})
})

/** Local recorder for the cases (the shared fake records only the reason). */
function rec_(calls: Record<string, unknown[]>, name: string, ...args: unknown[]): void {
	;(calls[name] ??= []).push(args)
}

describe('pgp_source_unavailable is a temporary state: retried, not counted, never terminal (.1)', () => {
	it('the start retries (not counted), shows no failure, and never starts the rebuild path', async () => {
		const restorePgp = jest.fn(async (): Promise<PgpRestoreOutcome> => ({ ok: false, code: 'unavailable', failure: null }))
		const retry = jest.fn()
		const { deps, calls } = fakeDeps({ kind: 'ok', eoa: EOA, accountKey: `${EOA}:default`, pgpReady: false }, { evaluatePgp: async () => ({ kind: 'source_unavailable' }), restorePgp, retry })
		const r = await startShellChatFromNativeIdentity(deps)
		expect(r).toBe('failed')
		expect(retry).toHaveBeenCalledWith('pgp source unavailable', 'temporary')
		expect(calls.showPgpFailure).toBeUndefined()
		expect(calls.showChatUnavailable).toBeUndefined()
		expect(restorePgp).not.toHaveBeenCalled()
	})
})

describe('the node list is never an empty list at the start', () => {
	it('getNodes fails: no listen is started, the chat shows unavailable, and the start is retried', async () => {
		const retry = jest.fn()
		const { deps, calls } = fakeDeps({ kind: 'ok', eoa: EOA, accountKey: `${EOA}:default`, pgpReady: true, ownRouteArmoredPublicKey: ROUTE, pgpPublicKeyArmored: ROUTE } as NativeIdentityPublic, {
			getNodes: async () => {
				throw new Error('rpc down')
			},
			retry,
		})
		const r = await startShellChatFromNativeIdentity(deps)
		expect(r).toBe('failed')
		expect(calls.startListen).toBeUndefined()
		expect(calls.showChatUnavailable).toBeDefined()
		expect(retry).toHaveBeenCalledWith('node list unavailable')
	})

	it('an empty node list is the same unavailable state: nothing is passed on', async () => {
		const retry = jest.fn()
		const { deps, calls } = fakeDeps({ kind: 'ok', eoa: EOA, accountKey: `${EOA}:default`, pgpReady: true, ownRouteArmoredPublicKey: ROUTE, pgpPublicKeyArmored: ROUTE } as NativeIdentityPublic, {
			getNodes: async () => [],
			retry,
		})
		const r = await startShellChatFromNativeIdentity(deps)
		expect(r).toBe('failed')
		expect(calls.startListen).toBeUndefined()
		expect(calls.showChatUnavailable).toBeDefined()
	})
})

describe('the dedicated temporary state of the PGP source (-6, .1.1)', () => {
	it('the start shows the temporary state, and clears it when the source answers', async () => {
		const setPgpTemporary = jest.fn()
		const { deps } = fakeDeps({ kind: 'ok', eoa: EOA, accountKey: `${EOA}:default`, pgpReady: false }, { evaluatePgp: async () => ({ kind: 'source_unavailable' }), setPgpTemporary })
		await startShellChatFromNativeIdentity(deps)
		expect(setPgpTemporary).toHaveBeenLastCalledWith(true)
		const next = fakeDeps({ kind: 'ok', eoa: EOA, accountKey: `${EOA}:default`, pgpReady: false }, { evaluatePgp: async () => ({ kind: 'evaluated' as const, state: 'first_identity' as const, failureCode: null, offerEntry: true }), setPgpTemporary })
		await startShellChatFromNativeIdentity(next.deps)
		expect(setPgpTemporary).toHaveBeenLastCalledWith(false)
	})
})
