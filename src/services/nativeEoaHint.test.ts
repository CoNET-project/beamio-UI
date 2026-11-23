/**
 * r95 (native EOA hint): a pwaWalletSync reply `ok` records the EOA the page sent with the confirmed write; nothing else records it. SYNTHETIC values
 * only (the phrase is the public BIP-39 test vector, the EOA is the address it derives to).
 */
import { createShellMnemonicSync } from './shellMnemonicSync'
import { resetShellSyncStatus } from './shellSyncStatus'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const noWait = async () => undefined

function harness(send: jest.Mock, opts: { bridge?: boolean; onSynced?: jest.Mock } = {}) {
	return createShellMnemonicSync({
		send,
		retryDelaysMs: [],
		wait: noWait,
		log: () => undefined,
		bridgeAvailable: () => opts.bridge ?? true,
		nextSeq: () => 1,
		onSynced: opts.onSynced,
	})
}

beforeEach(() => resetShellSyncStatus())

describe('r95: the hint is recorded only after a confirmed ok reply', () => {
	it('ok: onSynced is called once with the account EOA sent in the request', async () => {
		const onSynced = jest.fn()
		const sync = harness(jest.fn(async () => 'ok' as const), { onSynced })
		expect((await sync.sync(PHRASE, EOA)).kind).toBe('synced')
		expect(onSynced).toHaveBeenCalledTimes(1)
		expect(onSynced).toHaveBeenCalledWith(EOA)
	})

	it.each(['stale_seq', 'write_failed', 'untrusted_source', 'bad_request', 'no_answer', 'key_over_bridge_refused'] as const)(
		'reply %s: onSynced is not called',
		async (code) => {
			const onSynced = jest.fn()
			const sync = harness(jest.fn(async () => code), { onSynced })
			await sync.sync(PHRASE, EOA)
			expect(onSynced).not.toHaveBeenCalled()
		},
	)

	it('a throwing onSynced does not change the sync result', async () => {
		const sync = harness(jest.fn(async () => 'ok' as const), { onSynced: jest.fn(() => { throw new Error('hint store down') }) })
		expect((await sync.sync(PHRASE, EOA)).kind).toBe('synced')
	})

	it('browser (no trusted bridge): no send, no hint', async () => {
		const send = jest.fn(async () => 'ok' as const)
		const onSynced = jest.fn()
		const sync = harness(send, { bridge: false, onSynced })
		expect((await sync.sync(PHRASE, EOA)).kind).toBe('unavailable')
		expect(send).not.toHaveBeenCalled()
		expect(onSynced).not.toHaveBeenCalled()
	})
})

describe('r95: rememberNativeEoa keeps its existing semantics (format check, last value wins)', () => {
	const persist = jest.fn()
	beforeEach(() => {
		jest.resetModules()
		persist.mockClear()
		// only the persistence seam is real here; the other imports of nativeWallet are stubbed so the module loads in jsdom
		jest.doMock('./shellIdentitySource', () => ({ persistShellEoa: persist, readPersistedShellEoa: () => '' }))
		jest.doMock('./nativeRecovery', () => ({ queryNativeWalletStatus: jest.fn() }))
		jest.doMock('./chatWorkerBridge', () => ({ forgetInitRefusal: jest.fn(), initShellIdentityOnly: jest.fn() }))
		jest.doMock('./nativeChatRouteRegister', () => ({ probeNativeCapabilities: jest.fn() }))
		jest.doMock('./shellEntryDecision', () => ({ identityCapabilityFrom: jest.fn(), nativeInitAllowed: jest.fn() }))
		jest.doMock('./coNETNodeRead', () => ({ readNodeListForInit: jest.fn() }))
		jest.doMock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
		jest.doMock('./nativeIosShell', () => ({ isIosNativeShell: () => false }))
		jest.doMock('@/utils/accountNameGuard', () => ({ deviceCachedBeamioTagFor: () => '', rememberDeviceBeamioTag: jest.fn() }))
	})

	it('a valid address is persisted lower-case', () => {
		const { rememberNativeEoa } = require('./nativeWallet') as typeof import('./nativeWallet')
		rememberNativeEoa('0x9858EFFD232B4033E47D90003D41EC34ECAEDA94')
		expect(persist).toHaveBeenCalledWith(EOA)
	})

	it('a missing, empty or malformed value is not persisted', () => {
		const { rememberNativeEoa } = require('./nativeWallet') as typeof import('./nativeWallet')
		rememberNativeEoa(undefined)
		rememberNativeEoa(null)
		rememberNativeEoa('')
		rememberNativeEoa('0x1234')
		rememberNativeEoa('0xZZ58effd232b4033e47d90003d41ec34ecaeda94')
		expect(persist).not.toHaveBeenCalled()
	})

	it('a different valid address replaces the previous hint (no new overwrite rule)', () => {
		const { rememberNativeEoa } = require('./nativeWallet') as typeof import('./nativeWallet')
		rememberNativeEoa(EOA)
		rememberNativeEoa('0x1111111111111111111111111111111111111111')
		expect(persist.mock.calls.map((c) => c[0])).toEqual([EOA, '0x1111111111111111111111111111111111111111'])
	})
})

describe('r95: production wiring (static)', () => {
	it('the production sync records the hint through the lazy nativeWallet import, only in the onSynced hook', () => {
		const src = require('fs').readFileSync(require('path').join(__dirname, 'shellMnemonicSync.ts'), 'utf8') as string
		expect(src).toContain("void import('./nativeWallet').then((m) => m.rememberNativeEoa(eoa)).catch(() => undefined)")
		expect(src.split('deps.onSynced?.(eoa)').length - 1).toBe(1)
	})
})

describe('r95: the production instance (runtime, not static)', () => {
	const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
	it('(a) without a trusted bridge the production instance does not record the hint', async () => {
		jest.resetModules()
		const remember = jest.fn()
		jest.doMock('./nativeWallet', () => ({ rememberNativeEoa: remember }))
		const mod = require('./shellMnemonicSync') as typeof import('./shellMnemonicSync')
		const out = await mod.shellMnemonicSync.sync(PHRASE, EOA)
		await flush()
		expect(out.kind).toBe('unavailable')
		expect(remember).not.toHaveBeenCalled()
	})
	it('(b) a rejected lazy import does not change the sync result and is not an unhandled rejection', async () => {
		jest.resetModules()
		jest.doMock('./nativeWallet', () => {
			throw new Error('module load failed (test)')
		})
		const mod = require('./shellMnemonicSync') as typeof import('./shellMnemonicSync')
		const send = jest.fn(async () => 'ok' as const)
		mod.setShellMnemonicSyncBridge(send)
		const onRejection = jest.fn()
		process.on('unhandledRejection', onRejection)
		try {
			const out = await mod.shellMnemonicSync.sync(PHRASE, EOA)
			await flush()
			await flush()
			expect(out.kind).toBe('synced')
			expect(send).toHaveBeenCalledTimes(1)
			expect(onRejection).not.toHaveBeenCalled()
		} finally {
			process.off('unhandledRejection', onRejection)
			mod.setShellMnemonicSyncBridge(null)
		}
	})
})
