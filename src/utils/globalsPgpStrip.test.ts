/**
 * Boundary: in a shell the state setter removes the PGP private key and keeps the EOA key the page
 * owns. A browser build is unchanged.
 */
import { CoNET_Data, setCoNET_Data } from './globals'

describe('setCoNET_Data: PGP only in a shell', () => {
	const saved = process.env.REACT_APP_SHELL_BUILD
	afterEach(() => {
		if (saved === undefined) delete process.env.REACT_APP_SHELL_BUILD
		else process.env.REACT_APP_SHELL_BUILD = saved
	})

	const blob = () =>
		({
			profiles: [{ keyID: '0x' + '1'.repeat(40), privateKeyArmor: '0x' + '2'.repeat(64), chatManager: { pgpKey: { publicKey: 'PUB', privateKey: 'PGP-PRIV' } } }],
		}) as any

	it('shell: the PGP private key is removed, the EOA key stays', () => {
		process.env.REACT_APP_SHELL_BUILD = 'true'
		setCoNET_Data(blob())
		const p0 = (CoNET_Data as any).profiles[0]
		expect(p0.chatManager.pgpKey.privateKey).toBeUndefined()
		expect(p0.privateKeyArmor).toBe('0x' + '2'.repeat(64))
	})

	it('browser: nothing is removed', () => {
		delete process.env.REACT_APP_SHELL_BUILD
		setCoNET_Data(blob())
		const p0 = (CoNET_Data as any).profiles[0]
		expect(p0.chatManager.pgpKey.privateKey).toBe('PGP-PRIV')
	})
})
