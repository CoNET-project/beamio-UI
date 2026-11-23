/**
 * @jest-environment node
 *
 * HC-LOCK for init (v10 §12.3; INIT-3, INIT-4): an init answered locked is held; no init is sent during the lock; one more after the unlock.
 */
jest.mock('./nativeRecovery', () => ({ queryNativeWalletStatus: jest.fn() }))
jest.mock('./chatWorkerBridge', () => ({ initShellIdentityOnly: jest.fn(), forgetInitRefusal: jest.fn() }))
jest.mock('./nativeChatRouteRegister', () => ({ probeNativeCapabilities: jest.fn() }))
jest.mock('./coNETNodeRead', () => ({ readNodeListForInit: jest.fn(async () => []) }))
jest.mock('./shellIdentitySource', () => ({ persistShellEoa: jest.fn(), readPersistedShellEoa: jest.fn(() => '0x' + 'ab'.repeat(20)) }))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))

import { queryNativeWalletStatus } from './nativeRecovery'
import { initShellIdentityOnly } from './chatWorkerBridge'
import { probeNativeCapabilities } from './nativeChatRouteRegister'
import { isLockedInitReason, reachNativeWallet, releaseInitLockedHold, takeInitRefusal } from './nativeWallet'

const notReady = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
const locked = { status: 'locked' }

beforeEach(() => {
	;(queryNativeWalletStatus as jest.Mock).mockReset().mockResolvedValue(notReady)
	;(initShellIdentityOnly as jest.Mock).mockReset().mockResolvedValue({ ok: false, reason: 'locked' })
	;(probeNativeCapabilities as jest.Mock).mockReset().mockResolvedValue({ answered: true, capabilities: ['identity.native-keys.v1'] })
	const { readPersistedShellEoa } = jest.requireMock('./shellIdentitySource') as { readPersistedShellEoa: jest.Mock }
	readPersistedShellEoa.mockReset().mockReturnValue('0x' + 'ab'.repeat(20))
	const { readNodeListForInit } = jest.requireMock('./coNETNodeRead') as { readNodeListForInit: jest.Mock }
	readNodeListForInit.mockReset().mockResolvedValue([])
	releaseInitLockedHold()
})

describe('HC-LOCK init', () => {
	it('INIT-3: an init answered locked is recognised as the lock, not an address mismatch', () => {
		expect(isLockedInitReason('locked')).toBe(true)
		expect(isLockedInitReason('unlocked')).toBe(false)
		expect(isLockedInitReason('address_mismatch')).toBe(false)
	})

	it('INIT-3/INIT-4: while locked, repeated reaches send the init once, not again', async () => {
		await reachNativeWallet()
		;(queryNativeWalletStatus as jest.Mock).mockResolvedValue(locked)
		await reachNativeWallet()
		await reachNativeWallet()
		expect(initShellIdentityOnly).toHaveBeenCalledTimes(1)
		expect(takeInitRefusal()).toBe('locked')
	})

	it('after the unlock is released, one more init may be sent', async () => {
		await reachNativeWallet()
		releaseInitLockedHold()
		await reachNativeWallet()
		expect(initShellIdentityOnly).toHaveBeenCalledTimes(2)
	})
})
