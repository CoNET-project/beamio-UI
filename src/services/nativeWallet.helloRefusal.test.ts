/**
 * The entry path with the real hello probe: a refused hello (ok false) sends no init; a hello declared later sends one.
 * Only the bridge is stubbed. Synthetic values only.
 */
jest.mock('./nativeRecovery', () => ({ queryNativeWalletStatus: jest.fn() }))
jest.mock('./chatWorkerBridge', () => ({ initShellIdentityOnly: jest.fn(), forgetInitRefusal: jest.fn() }))
jest.mock('./coNETNodeRead', () => ({ readNodeListForInit: jest.fn(async () => []) }))
jest.mock('./shellIdentitySource', () => ({ persistShellEoa: jest.fn(), readPersistedShellEoa: jest.fn(() => '0x' + 'ab'.repeat(20)) }))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))

import { queryNativeWalletStatus } from './nativeRecovery'
import { initShellIdentityOnly } from './chatWorkerBridge'
import { readNodeListForInit } from './coNETNodeRead'
import { readPersistedShellEoa } from './shellIdentitySource'
import { reachNativeWallet } from './nativeWallet'

const notReady = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }

/** The reply the next hello gets: a refusal, a declaration, or nothing (a timeout). */
let helloReply: 'refused' | 'declared' | 'silent' = 'refused'

// The jest setup resets mock implementations before each test, so each return value is set here.
beforeEach(() => {
	helloReply = 'refused'
	;(queryNativeWalletStatus as jest.Mock).mockReset().mockResolvedValue(notReady)
	;(initShellIdentityOnly as jest.Mock).mockReset().mockResolvedValue({ ok: true })
	// the device holds a public address, so an init would be sent once the capability is declared
	;(readPersistedShellEoa as jest.Mock).mockReset().mockReturnValue('0x' + 'ab'.repeat(20))
	;(readNodeListForInit as jest.Mock).mockReset().mockResolvedValue([])
	;(window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS = {
		chatModuleCommand: (wire: { command: { type: string; reqId: number } }) => {
			const cmd = wire.command
			if (cmd.type !== 'hello' || helloReply === 'silent') return
			const payload =
				helloReply === 'declared'
					? { type: 'ready', reqId: cmd.reqId, result: { capabilities: ['identity.native-keys.v1'] } }
					: { type: 'ack', reqId: cmd.reqId, ok: false, error: 'unknown_command', result: { capabilities: ['identity.native-keys.v1'] } }
			window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } }))
		},
	}
})

afterEach(() => {
	delete (window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS
})

describe('the entry path with the real hello probe', () => {
	it('a refused hello sends no init, even when its answer lists the capability', async () => {
		helloReply = 'refused'
		const state = await reachNativeWallet()
		expect(initShellIdentityOnly).not.toHaveBeenCalled()
		expect(state.status).toBe('not_ready')
	})

	it('a hello refused first and declared later sends exactly one init', async () => {
		helloReply = 'refused'
		await reachNativeWallet()
		expect(initShellIdentityOnly).not.toHaveBeenCalled()
		helloReply = 'declared'
		await reachNativeWallet()
		expect(initShellIdentityOnly).toHaveBeenCalledTimes(1)
	})
})
