/**
 * The native public EOA becoming known tells the subscribers (the history read of a shell is evaluated again at that moment, also when the
 * page's profiles have not changed since). SYNTHETIC values.
 */
jest.mock('./nativeChatRouteRegister', () => ({ probeNativeCapabilities: jest.fn(), requestNativeAck: jest.fn() }))

import { probeNativeCapabilities, requestNativeAck } from './nativeChatRouteRegister'
import { readNativeIdentityPublic, onShellPublicEoaChange, shellPublicEoaOrEmpty } from './nativeIdentityPublic'
import fs from 'fs'
import path from 'path'

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const OTHER = '0x1111111111111111111111111111111111111111'
const ok = (eoa: string) => ({ kind: 'payload', payload: { type: 'ack', ok: true, result: { eoa, accountKey: `${eoa}:default`, pgpReady: false } } })

describe('onShellPublicEoaChange', () => {
	beforeEach(() => {
		;(probeNativeCapabilities as jest.Mock).mockReset().mockResolvedValue({ answered: true, capabilities: ['identity.kpresent.v1'] })
		;(requestNativeAck as jest.Mock).mockReset()
	})
	it('fires when an identityPublic answer makes the EOA known or changes it, not when it is the same again', async () => {
		const seen: string[] = []
		const off = onShellPublicEoaChange(() => seen.push(shellPublicEoaOrEmpty()))
		;(requestNativeAck as jest.Mock).mockResolvedValue(ok(EOA))
		await readNativeIdentityPublic()
		expect(seen).toEqual([EOA])
		await readNativeIdentityPublic()
		expect(seen).toEqual([EOA])
		;(requestNativeAck as jest.Mock).mockResolvedValue(ok(OTHER))
		await readNativeIdentityPublic()
		expect(seen).toEqual([EOA, OTHER])
		off()
		;(requestNativeAck as jest.Mock).mockResolvedValue(ok(EOA))
		await readNativeIdentityPublic()
		expect(seen).toEqual([EOA, OTHER])
	})
	it('a listener that throws does not break the read', async () => {
		const off = onShellPublicEoaChange(() => {
			throw new Error('x')
		})
		;(requestNativeAck as jest.Mock).mockResolvedValue(ok('0x2222222222222222222222222222222222222222'))
		await expect(readNativeIdentityPublic()).resolves.toMatchObject({ kind: 'ok' })
		off()
	})
})

describe('App: the history read gate is evaluated again when the native EOA is known', () => {
	it('the effect depends on a tick bumped by onShellPublicEoaChange', () => {
		const app = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8')
		expect(app).toContain('useEffect(() => onShellPublicEoaChange(() => setNativeEoaTick((n) => n + 1)), [])')
		expect(app).toContain('[historyKeyPresent, workerEpoch, shellStartedTick, nativeEoaTick, profiles, corpusAccountOf]')
	})
})
