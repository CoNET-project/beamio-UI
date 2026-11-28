/**
 * @jest-environment node
 */
/**
 * a start that read the first identity as "not confirmed" left the chat UI state at `identity_pending`; when the first identity
 * was `registered` the next start read the identity fine but the listen start refused (the state was not native_chat) and logged "native listen did not start", on every retry, until a cold start.
 * The start now withdraws that state when the identity is ready. SYNTHETIC values.
 */
import { resetShellChatStartLoopGuard, startShellChatFromNativeIdentity, type ShellChatStartDeps } from './shellChatStart'
import type { NativeIdentityPublic } from './nativeIdentityPublic'
import { getShellChatUiState, setShellChatUiState } from './shellChatUiState'
import { shellChatBlocked } from './shellChatCapability'
import fs from 'fs'
import path from 'path'

beforeEach(() => resetShellChatStartLoopGuard())

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const READY: NativeIdentityPublic = {
	kind: 'ok',
	eoa: EOA,
	accountKey: `${EOA}:default`,
	pgpReady: true,
	pgpKeyID: 'k',
	pgpPublicKeyArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nsynthetic\n-----END PGP PUBLIC KEY BLOCK-----',
	ownRouteArmoredPublicKey: 'route-1',
}
const NODES = [{ domain: 'NODEA', armoredPublicKey: 'a' }]

/** the listen start as the real one decides it: refused while the shell chat UI state is not native_chat (shellChatBlockedNow) */
function deps(overrides: Partial<ShellChatStartDeps> = {}) {
	const startListen = jest.fn(async () => !shellChatBlocked({ shell: true, state: getShellChatUiState() }))
	const d: ShellChatStartDeps = {
		readIdentity: async () => READY,
		getNodes: async () => NODES,
		setAllNodes: () => undefined,
		setGossip: () => undefined,
		mailboxDomainsFor: () => new Set<string>(),
		pickEntries: async (c) => c,
		onListenPlanned: () => undefined,
		onController: () => undefined,
		startListen,
		onLine: () => undefined,
		onActivity: () => undefined,
		log: () => undefined,
		retry: () => undefined,
		readPersistedEoa: () => EOA,
		setIdentityPending: () => undefined,
		setFirstIdentity: () => undefined,
		evaluatePgp: async () => ({ kind: 'unavailable' }),
		restorePgp: async () => ({ ok: false, code: 'unavailable', failure: null }),
		showPgpFailure: () => undefined,
		showChatUnavailable: () => undefined,
		showIdentityPending: () => undefined,
		...overrides,
	} as ShellChatStartDeps
	return { d, startListen }
}
const ui = () => getShellChatUiState()

describe('the identity is ready, a notice left by an earlier start is withdrawn', () => {
	it('identity_pending left by the earlier start: without the withdrawal the listen start is refused', async () => {
		setShellChatUiState('identity_pending')
		const { d } = deps() // no markChatUiReady: the old behaviour
		expect(await startShellChatFromNativeIdentity(d)).toBe('failed') // listen did not start
	})

	it('with the withdrawal the same start reaches the listen and starts (the first identity registered, the next start)', async () => {
		setShellChatUiState('identity_pending')
		const markChatUiReady = jest.fn(async () => setShellChatUiState('native_chat'))
		const { d, startListen } = deps({ markChatUiReady })
		expect(await startShellChatFromNativeIdentity(d)).toBe('started')
		expect(markChatUiReady).toHaveBeenCalledTimes(1)
		expect(startListen).toHaveBeenCalledTimes(1)
		expect(ui()).toBe('native_chat')
	})

	it('chat_unavailable left by an earlier start (no nodes then) is withdrawn the same way', async () => {
		setShellChatUiState('chat_unavailable')
		const { d } = deps({ markChatUiReady: async () => setShellChatUiState('native_chat') })
		expect(await startShellChatFromNativeIdentity(d)).toBe('started')
	})

	it('it is called only when the identity is ready: an identity that is not ready does not clear the notice', async () => {
		setShellChatUiState('identity_pending')
		const markChatUiReady = jest.fn()
		const { d } = deps({ markChatUiReady, readIdentity: async () => ({ ...READY, pgpReady: false, pgpPublicKeyArmored: undefined }) as NativeIdentityPublic, evaluatePgp: async () => ({ kind: 'unavailable' }) })
		await startShellChatFromNativeIdentity(d)
		expect(markChatUiReady).not.toHaveBeenCalled()
	})
})

describe('the chat.ts implementation (static)', () => {
	const chat = fs.readFileSync(path.join(__dirname, 'chat.ts'), 'utf8')
	it('puts the state back only when the capability answer says native chat', () => {
		const block = chat.slice(chat.indexOf('markChatUiReady: async'), chat.indexOf('markChatUiReady: async') + 260)
		expect(block).toMatch(/getShellChatUiState\(\) === 'native_chat'\) return/)
		expect(block).toMatch(/\(await ensureShellChatState\(\)\) === 'native_chat'\) setShellChatUiState\('native_chat', 'identity_ready'\)/)
	})
	it('shellChatStart calls it after the identity checks and before the nodes are read', () => {
		const start = fs.readFileSync(path.join(__dirname, 'shellChatStart.ts'), 'utf8')
		expect(start.indexOf('await deps.markChatUiReady?.()')).toBeGreaterThan(start.indexOf('return evaluateMissingPgp(deps, accountKeyOf(id))'))
		expect(start.indexOf('await deps.markChatUiReady?.()')).toBeLessThan(start.indexOf('const nodes = await readNodesOrUnavailable(deps)', start.indexOf('await deps.markChatUiReady?.()')))
	})
})
