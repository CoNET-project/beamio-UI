/**
 * Restore screen (real component, real route state): exactly two entries (BeamioTag and password; recovery code). No mnemonic
 * import and no mnemonic text box. The create-account entry is not one of the restore entries.
 */
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
window.matchMedia = window.matchMedia || ((q: string) => ({ matches: false, media: q, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) as unknown as MediaQueryList)
;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || class { observe() {} unobserve() {} disconnect() {} }

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { restoreWithRedeemDetailed, restoreWithUserPin } from '@/services/beamio'
import { C2_SAMPLE_PHRASE } from './restoreEntryFixture'

jest.mock('@/locale/beamioLocale', () => ({ ...jest.requireActual('@/locale/beamioLocale'), tu: (key: string) => key, useTu: () => ({ tu: (key: string) => key, locale: 'en' }) }))
jest.mock('@/services/beamio', () => ({ onWalletEvent: (name: string, cb: (v: string) => void) => { if (name === 'scan:url') (globalThis as { __scanUrl?: (v: string) => void }).__scanUrl = cb; return () => undefined }, restoreWithRedeemDetailed: jest.fn(), restoreWithUserPin: jest.fn() }))
jest.mock('@/services/nativeRecovery', () => ({ nativeRecoveryCopyKey: () => null, nativeRecoveryOpen: jest.fn(), onNativeRecoveryResult: () => () => undefined, recoveryOpenErrorKey: () => '' }))
jest.mock('@/services/nativeWallet', () => ({ notifyNativeWalletReady: jest.fn(), rememberNativeEoa: jest.fn(), reachNativeWallet: jest.fn() }))
jest.mock('@/services/argon2WorkerBridge', () => ({ warmArgon2Worker: jest.fn() }))
jest.mock('@/services/shellContext', () => ({ isShellContext: () => false }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({ getCashTreesNativeNfcBridge: () => null, getCashTreesNativeNfcHost: () => null }))
jest.mock('./RecoveryQrScanPanel', () => () => null)
jest.mock('./VerraFloatingNavChrome', () => ({ VerraFloatingNavChrome: () => null }))

// required after the polyfills above (the module reads TextEncoder when it loads)
const RestoreWalletUnifiedScreen = require('./RestoreWalletUnifiedScreen').default

describe('restore screen: the entries (real component)', () => {
	it('shows the BeamioTag and password entry and the recovery code entry, and nothing else as an entry', () => {
		render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} />)
		expect(screen.getByText('unlock')).toBeTruthy()
		expect(screen.getByText('use_recovery_code')).toBeTruthy()
		expect(screen.queryByText('create_account')).toBeNull()
	})

	it('has no mnemonic import and no mnemonic text box', () => {
		render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} />)
		const boxes = Array.from(document.querySelectorAll('textarea, input')) as HTMLElement[]
		for (const el of boxes) {
			const hint = `${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('name') ?? ''}`
			expect(hint.toLowerCase()).not.toMatch(/mnemonic|phrase|seed/)
		}
		expect(document.querySelectorAll('textarea').length).toBe(0)
	})

	it('the recovery code entry opens its own form (the code box) from the second entry', () => {
		render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} />)
		fireEvent.click(screen.getByText('use_recovery_code'))
		expect(screen.getByText('recovery_code_label')).toBeTruthy()
		expect(screen.getByPlaceholderText('enter_or_paste_your_code')).toBeTruthy()
	})
})

// Per C-2: the scan path accepts only the recovery code format. The scan:url callback is captured by the mock above.
describe('scan path: only the recovery code format fills the field (a QR is not a mnemonic or key import)', () => {
	const scan = (value: string) => {
		const fn = (globalThis as { __scanUrl?: (v: string) => void }).__scanUrl
		act(() => {
			fn?.(value)
		})
	}
	const codeField = () => screen.getByPlaceholderText('enter_or_paste_your_code') as HTMLInputElement
	beforeEach(() => {
		render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} />)
		fireEvent.click(screen.getAllByRole('button', { name: 'use_recovery_code' })[0])
	})

	it('a recovery code (22 base62 characters, the generateCODE format) fills the recovery code field', () => {
		const code = 'a1B2c3D4e5F6g7H8i9J0kL'
		scan(code)
		expect(codeField().value).toBe(code)
	})

	it('a mnemonic phrase in the QR is refused: the field stays empty and the format error shows', () => {
		scan('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
		expect(codeField().value).toBe('')
		expect(screen.getByText('invalid_recovery_code_format')).toBeTruthy()
	})

	it('a private key in the QR is refused, and so is a URL', () => {
		scan('0x' + '1'.repeat(64))
		expect(codeField().value).toBe('')
		scan('https://example.invalid/restore')
		expect(codeField().value).toBe('')
	})
})

// C-2 acceptance: exactly two recovery entries; neither takes a mnemonic or a private key; both hand the same
// fixed phrase to the restore (the derivation to the fixed address is in restoreEntryDerivation.node.test.ts).
describe('C-2: exactly two recovery entries, and both restore the same fixed sample', () => {
	const restored = () => ({ mnemonicPhrase: C2_SAMPLE_PHRASE, beamio: { accountName: 'synthtag' }, profiles: [{ keyID: '0x0', privateKeyArmor: 'armor' }] })
	it('the first screen has exactly two entries: BeamioTag with password (unlock) and the recovery code; no import, no mnemonic or key', () => {
		render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} />)
		const labels = screen.getAllByRole('button').map((b) => (b.textContent ?? '').trim())
		const entries = labels.filter((l) => l === 'unlock' || l === 'use_recovery_code')
		expect(entries.sort()).toEqual(['unlock', 'use_recovery_code'])
		expect(labels.join('|')).not.toMatch(/mnemonic|phrase|private|import|seed|key/i)
		expect(screen.queryByText('create_account')).toBeNull()
	})
	it('both entries pass the same phrase to the restore: the BeamioTag and password entry, and the recovery code entry', async () => {
		const onRestore = jest.fn()
		;(restoreWithUserPin as jest.Mock).mockResolvedValue(restored())
		;(restoreWithRedeemDetailed as jest.Mock).mockResolvedValue({ kind: 'ok', temp: restored() })
		render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={onRestore} />)
		// entry 1: BeamioTag and password
		fireEvent.change(screen.getByPlaceholderText('yourtag'), { target: { value: 'synthtag' } })
		fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: 'Passw0rd-sample' } })
		fireEvent.submit(screen.getByPlaceholderText('yourtag').closest('form') as HTMLFormElement)
		await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
		// entry 2: the recovery code (a QR scan fills the same field only in this format)
		fireEvent.click(screen.getAllByRole('button', { name: 'use_recovery_code' })[0])
		fireEvent.change(screen.getByPlaceholderText('enter_or_paste_your_code'), { target: { value: 'a1B2c3D4e5F6g7H8i9J0kL' } })
		fireEvent.submit(screen.getByPlaceholderText('enter_or_paste_your_code').closest('form') as HTMLFormElement)
		await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(2))
		const phrases = onRestore.mock.calls.map((c) => (c[0] as { temp: { mnemonicPhrase: string } }).temp.mnemonicPhrase)
		expect(phrases).toEqual([C2_SAMPLE_PHRASE, C2_SAMPLE_PHRASE])
	})
})
