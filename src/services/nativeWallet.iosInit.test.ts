/**
 * /: how many native inits reachNativeWallet sends. iOS not_ready with unreadable sends ONE init when the public
 * address hint is on this device (and identity is declared); no hint sends none; Android never sends it for unreadable;
 * g1_uninitialized keeps its own rule. The native bridge is stubbed at the request boundary.
 */
export {}
const EOA = '0x1111111111111111111111111111111111111111'

type Status = { status: string; notReadyReason?: string; eoa?: string }

function load(opts: { ios: boolean; hint: boolean; statuses: Status[] }) {
	jest.resetModules()
	;(window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS = opts.ios ? {} : undefined
	if (!opts.ios) (window as unknown as { CashTreesAndroid?: unknown }).CashTreesAndroid = {}
	const queue = [...opts.statuses]
	const initShellIdentityOnly = jest.fn(async (_eoa: string, _nodes: unknown[]) => ({ ok: true as const }))
	jest.doMock('./nativeRecovery', () => ({ queryNativeWalletStatus: jest.fn(async () => queue.shift() ?? queue[queue.length - 1] ?? { status: 'unknown' }) }))
	jest.doMock('./nativeChatRouteRegister', () => ({ probeNativeCapabilities: jest.fn(async () => ({ answered: true, capabilities: ['identity.native-keys.v1'] })) }))
	jest.doMock('./chatWorkerBridge', () => ({ forgetInitRefusal: jest.fn(), initShellIdentityOnly }))
	jest.doMock('./coNETNodeRead', () => ({ readNodeListForInit: jest.fn(async () => []) }))
	jest.doMock('./shellIdentitySource', () => ({ persistShellEoa: jest.fn(), readPersistedShellEoa: jest.fn(() => '') }))
	jest.doMock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
	jest.doMock('@/utils/accountNameGuard', () => ({ deviceCachedBeamioTagFor: jest.fn(), rememberDeviceBeamioTag: jest.fn() }))
	const mod = require('./nativeWallet') as typeof import('./nativeWallet')
	if (opts.hint) mod.rememberNativeEoa(EOA)
	return { mod, initShellIdentityOnly }
}

afterEach(() => {
	delete (window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS
	delete (window as unknown as { CashTreesAndroid?: unknown }).CashTreesAndroid
	jest.dontMock('./nativeRecovery')
})

describe('native init count', () => {
	it('iOS unreadable with the public address on this device: exactly one init', async () => {
		const { mod, initShellIdentityOnly } = load({ ios: true, hint: true, statuses: [{ status: 'not_ready', notReadyReason: 'unreadable' }, { status: 'not_ready', notReadyReason: 'unreadable' }] })
		const out = await mod.reachNativeWallet()
		expect(initShellIdentityOnly).toHaveBeenCalledTimes(1)
		expect(initShellIdentityOnly.mock.calls[0][0]).toBe(EOA)
		expect(out).toEqual({ status: 'not_ready', notReadyReason: 'unreadable' })
	})

	it('iOS unreadable without a hint: zero inits, the state is returned as not ready', async () => {
		const { mod, initShellIdentityOnly } = load({ ios: true, hint: false, statuses: [{ status: 'not_ready', notReadyReason: 'unreadable' }] })
		const out = await mod.reachNativeWallet()
		expect(initShellIdentityOnly).not.toHaveBeenCalled()
		expect(out).toEqual({ status: 'not_ready', notReadyReason: 'unreadable' })
	})

	it('Android unreadable with a hint: zero inits', async () => {
		const { mod, initShellIdentityOnly } = load({ ios: false, hint: true, statuses: [{ status: 'not_ready', notReadyReason: 'unreadable' }] })
		await mod.reachNativeWallet()
		expect(initShellIdentityOnly).not.toHaveBeenCalled()
	})

	it('iOS g1_uninitialized with a hint: one init (unchanged rule)', async () => {
		const { mod, initShellIdentityOnly } = load({ ios: true, hint: true, statuses: [{ status: 'not_ready', notReadyReason: 'g1_uninitialized' }, { status: 'unlocked', eoa: EOA }] })
		const out = await mod.reachNativeWallet()
		expect(initShellIdentityOnly).toHaveBeenCalledTimes(1)
		expect(out).toEqual({ status: 'unlocked', eoa: EOA })
	})
})
