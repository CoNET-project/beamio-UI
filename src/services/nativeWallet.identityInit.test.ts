/**
 * @jest-environment node
 *
 * The G1 init is an identity payload: it is sent only when the shell declared identity.native-keys.v1. Synthetic values only.
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
import { reachNativeWallet } from './nativeWallet'

const notReady = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }

// The jest setup resets mock implementations before each test, so each return value is set here.
beforeEach(() => {
	;(queryNativeWalletStatus as jest.Mock).mockReset().mockResolvedValue(notReady)
	;(initShellIdentityOnly as jest.Mock).mockReset().mockResolvedValue({ ok: true })
	;(probeNativeCapabilities as jest.Mock).mockReset()
	const { readPersistedShellEoa } = jest.requireMock('./shellIdentitySource') as { readPersistedShellEoa: jest.Mock }
	readPersistedShellEoa.mockReset().mockReturnValue('0x' + 'ab'.repeat(20))
	const { readNodeListForInit } = jest.requireMock('./coNETNodeRead') as { readNodeListForInit: jest.Mock }
	readNodeListForInit.mockReset().mockResolvedValue([])
})

describe('the G1 init is sent only with the declared capability', () => {
	it('a shell that answered hello without identity.native-keys.v1 receives no init', async () => {
		;(probeNativeCapabilities as jest.Mock).mockResolvedValue({ answered: true, capabilities: [] })
		const state = await reachNativeWallet()
		expect(initShellIdentityOnly).not.toHaveBeenCalled()
		expect(state).toEqual(notReady)
	})

	it('a shell that declared identity.native-keys.v1 receives exactly one init', async () => {
		;(probeNativeCapabilities as jest.Mock).mockResolvedValue({ answered: true, capabilities: ['identity.native-keys.v1'] })
		await reachNativeWallet()
		expect(initShellIdentityOnly).toHaveBeenCalledTimes(1)
	})

	it('an unanswered hello keeps the existing path: the init is sent as before', async () => {
		;(probeNativeCapabilities as jest.Mock).mockResolvedValue({ answered: false, capabilities: [] })
		await reachNativeWallet()
		expect(initShellIdentityOnly).toHaveBeenCalledTimes(1)
	})

	it('no public address on the device: no init, whatever the capability (nothing to initialise)', async () => {
		const { readPersistedShellEoa } = jest.requireMock('./shellIdentitySource') as { readPersistedShellEoa: jest.Mock }
		readPersistedShellEoa.mockReturnValueOnce('')
		;(probeNativeCapabilities as jest.Mock).mockResolvedValue({ answered: true, capabilities: ['identity.native-keys.v1'] })
		await reachNativeWallet()
		expect(initShellIdentityOnly).not.toHaveBeenCalled()
	})
})
