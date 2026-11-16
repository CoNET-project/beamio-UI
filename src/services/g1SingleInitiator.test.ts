/**
 * G1 has one initiator : the entry path (reachNativeWallet). The chain side is off (SHELL_G1_INIT_ENABLED = false),
 * so one G1 attempt sends exactly one identity-only init, and only from the entry path.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { persistShellEoa } from './shellIdentitySource'
import { reachNativeWallet, takeInitRefusal } from './nativeWallet'
import { SHELL_G1_INIT_ENABLED } from './shellChatStart'
import { queryNativeWalletStatus } from './nativeRecovery'
import { initShellIdentityOnly } from './chatWorkerBridge'
import { probeNativeCapabilities } from './nativeChatRouteRegister'

jest.mock('./nativeRecovery', () => ({ queryNativeWalletStatus: jest.fn() }))
// An init is sent only once the native hello declares identity.native-keys.v1; the G1 cases below assume it is declared.
jest.mock('./nativeChatRouteRegister', () => ({ probeNativeCapabilities: jest.fn() }))
// The node read goes to the chain; this test reads no network. The list is set per test.
jest.mock('./coNETNodeRead', () => ({ readNodeListForInit: jest.fn(async () => []) }))
import { readNodeListForInit } from './coNETNodeRead'
jest.mock('./chatWorkerBridge', () => ({
	initShellIdentityOnly: jest.fn(async () => ({ ok: false as const, reason: 'capability_missing' })),
}))
// The project's '@/' alias is not mapped for jest; the log module is virtual here (nativeWallet imports it by that alias).
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }), { virtual: true })

const EOA = '0x' + '1'.repeat(40)

describe('G1 has one initiator: the entry path', () => {
	beforeEach(() => {
		// CRA resets mock implementations before each test, so the native answer is set here.
		(initShellIdentityOnly as jest.Mock).mockResolvedValue({ ok: false, reason: 'capability_missing' })
		;(probeNativeCapabilities as jest.Mock).mockResolvedValue({ answered: true, capabilities: ['identity.native-keys.v1'] })
		;(readNodeListForInit as jest.Mock).mockResolvedValue([])
		jest.clearAllMocks()
		window.localStorage.clear()
	})

	it('the chain-side G1 init is off', () => {
		expect(SHELL_G1_INIT_ENABLED).toBe(false)
	})

	it('one G1 attempt with a persisted EOA sends exactly one identity-only init, with that EOA', async () => {
		persistShellEoa(EOA)
		;(queryNativeWalletStatus as jest.Mock).mockResolvedValue({ status: 'not_ready', notReadyReason: 'g1_uninitialized' })
		await reachNativeWallet()
		expect(initShellIdentityOnly).toHaveBeenCalledTimes(1)
		expect((initShellIdentityOnly as jest.Mock).mock.calls[0][0]).toBe(EOA)
	})

	it('a G1 init with a listed node set sends the list, and an empty or unavailable read sends no nodes (never an empty list)', async () => {
		persistShellEoa(EOA)
		;(queryNativeWalletStatus as jest.Mock).mockResolvedValue({ status: 'not_ready', notReadyReason: 'g1_uninitialized' })
		const nodes = [{ domain: 'a.example', armoredPublicKey: 'x' }]
		;(readNodeListForInit as jest.Mock).mockResolvedValueOnce(nodes)
		await reachNativeWallet()
		expect((initShellIdentityOnly as jest.Mock).mock.calls[0][1]).toEqual(nodes)
		;(readNodeListForInit as jest.Mock).mockResolvedValueOnce([])
		await reachNativeWallet()
		expect((initShellIdentityOnly as jest.Mock).mock.calls[1][1]).toEqual([])
	})

	it('an init refused with address_mismatch is recorded once for the local home to act on, then cleared', async () => {
		persistShellEoa(EOA)
		;(queryNativeWalletStatus as jest.Mock).mockResolvedValue({ status: 'not_ready', notReadyReason: 'g1_uninitialized' })
		;(initShellIdentityOnly as jest.Mock).mockResolvedValueOnce({ ok: false, reason: 'address_mismatch' })
		await reachNativeWallet()
		expect(takeInitRefusal()).toBe('address_mismatch')
		expect(takeInitRefusal()).toBeNull()
	})

	it('a G1 attempt with no persisted EOA sends no init', async () => {
		;(queryNativeWalletStatus as jest.Mock).mockResolvedValue({ status: 'not_ready', notReadyReason: 'g1_uninitialized' })
		await reachNativeWallet()
		expect(initShellIdentityOnly).not.toHaveBeenCalled()
	})

	it('the chain wiring passes the G1 initializer only through the switch', () => {
		const chat = readFileSync(join(__dirname, 'chat.ts'), 'utf8')
		expect(chat).toMatch(/initWithPersistedEoa: SHELL_G1_INIT_ENABLED\s*\?/)
	})
})

// Y.75: an unreadable (or reason-less) not_ready is undetermined; the entry path sends no init for it.
describe('G1 init is sent only for g1_uninitialized (Y.75)', () => {
	beforeEach(() => {
		;(probeNativeCapabilities as jest.Mock).mockResolvedValue({ answered: true, capabilities: ['identity.native-keys.v1'] })
		persistShellEoa(EOA)
	})
	for (const state of [{ status: 'not_ready', notReadyReason: 'unreadable' }, { status: 'not_ready' }]) {
		it(`no init for ${JSON.stringify(state)}`, async () => {
			;(queryNativeWalletStatus as jest.Mock).mockResolvedValue(state)
			await reachNativeWallet()
			expect(initShellIdentityOnly).not.toHaveBeenCalled()
		})
	}
})
