/**
 * HC-LOCK for identityPublic: a locked answer is its own kind, not bad_identity and not identity missing.
 */
jest.mock('./nativeChatRouteRegister', () => ({ probeNativeCapabilities: jest.fn(), requestNativeAck: jest.fn() }))

import { probeNativeCapabilities, requestNativeAck } from './nativeChatRouteRegister'
import { readNativeIdentityPublic } from './nativeIdentityPublic'

describe('identityPublic HC-LOCK (L-ID)', () => {
	beforeEach(() => {
		;(probeNativeCapabilities as jest.Mock).mockReset().mockResolvedValue({ answered: true, capabilities: ['identity.kpresent.v1'] })
		;(requestNativeAck as jest.Mock).mockReset()
	})

	it('a locked refusal is the locked kind, never bad_identity or no_key', async () => {
		;(requestNativeAck as jest.Mock).mockResolvedValue({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'locked' } })
		const r = await readNativeIdentityPublic()
		expect(r).toEqual({ kind: 'locked' })
	})

	it('regression: no_key and not_ready keep their own kinds', async () => {
		;(requestNativeAck as jest.Mock).mockResolvedValueOnce({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'no_key' } })
		expect((await readNativeIdentityPublic()).kind).toBe('no_key')
		;(requestNativeAck as jest.Mock).mockResolvedValueOnce({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'not_ready' } })
		expect((await readNativeIdentityPublic()).kind).toBe('not_ready')
	})
})
