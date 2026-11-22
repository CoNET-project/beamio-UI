/**
 * Setting import clean-up (item 3): the reveal screen is a display / export path. It takes the wallet password only and has no
 * mnemonic, private-key or phrase text box. Real render; the native and network calls are stubs. SYNTHETIC values only.
 */
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })

import { render } from '@testing-library/react'

jest.mock('@/providers/DaemonProvider', () => ({ useDaemonContext: () => ({ profiles: [] }) }))
jest.mock('@/services/beamio', () => ({ restoreWithUserPin: jest.fn() }))
jest.mock('@/services/shellContext', () => ({ isShellContext: () => false }))
jest.mock('@/services/nativeSigning', () => ({ nativeWalletBackupView: jest.fn() }))

// required after the polyfills above
const PrivateKeyReveal = require('./PrivateKey').default

describe('Setting: the private-key reveal screen has no hand-typed secret box', () => {
	it('renders one password input for the reveal and no textarea; no input names a mnemonic, phrase or private key', () => {
		const { container } = render(<PrivateKeyReveal privateKey="" onClose={jest.fn()} />)
		expect(container.querySelectorAll('textarea').length).toBe(0)
		const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
		expect(inputs.length).toBe(1)
		expect(inputs[0].type).toBe('password')
		for (const el of inputs) {
			const hint = `${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('name') ?? ''}`
			expect(hint.toLowerCase()).not.toMatch(/mnemonic|phrase|seed|private/)
		}
	})
})
