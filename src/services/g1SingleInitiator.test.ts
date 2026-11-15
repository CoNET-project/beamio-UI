/**
 * G1 has one initiator : the entry path (reachNativeWallet). The chain side is off (SHELL_G1_INIT_ENABLED = false),
 * so one G1 attempt sends exactly one identity-only init, and only from the entry path.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { persistShellEoa } from './shellIdentitySource'
import { reachNativeWallet } from './nativeWallet'
import { SHELL_G1_INIT_ENABLED } from './shellChatStart'
import { queryNativeWalletStatus } from './nativeRecovery'
import { initShellIdentityOnly } from './chatWorkerBridge'

jest.mock('./nativeRecovery', () => ({ queryNativeWalletStatus: jest.fn() }))
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
		jest.clearAllMocks()
		window.localStorage.clear()
	})

	it('the chain-side G1 init is off', () => {
		expect(SHELL_G1_INIT_ENABLED).toBe(false)
	})

	it('one G1 attempt with a persisted EOA sends exactly one identity-only init, with that EOA', async () => {
		persistShellEoa(EOA)
		;(queryNativeWalletStatus as jest.Mock).mockResolvedValue({ status: 'not_ready' })
		await reachNativeWallet()
		expect(initShellIdentityOnly).toHaveBeenCalledTimes(1)
		expect((initShellIdentityOnly as jest.Mock).mock.calls[0][0]).toBe(EOA)
	})

	it('a G1 attempt with no persisted EOA sends no init', async () => {
		;(queryNativeWalletStatus as jest.Mock).mockResolvedValue({ status: 'not_ready' })
		await reachNativeWallet()
		expect(initShellIdentityOnly).not.toHaveBeenCalled()
	})

	it('the chain wiring passes the G1 initializer only through the switch', () => {
		const chat = readFileSync(join(__dirname, 'chat.ts'), 'utf8')
		expect(chat).toMatch(/initWithPersistedEoa: SHELL_G1_INIT_ENABLED\s*\?/)
	})
})
