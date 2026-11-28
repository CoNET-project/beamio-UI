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
jest.mock('@/services/nativeRecovery', () => ({ nativeRecoveryCopyKey: () => null, nativeRecoveryOpen: jest.fn(), nativeRecoverySubmit: jest.fn(), nativeRecoveryCancel: jest.fn(), hasPageInputRecovery: async () => true, isTopFrameForRecovery: () => true, isTrustedRecoveryOrigin: () => true, onNativeRecoveryResult: () => () => undefined, recoveryOpenErrorKey: () => '' }))
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

// while the recovery code is submitting, init stores the recovered tag, so the parent re-renders this
// screen with a new initialBeamioTag. That must not switch the screen to the Unlock form (one-frame flash on iOS).
describe('the prefill effect must not leave the recovery tab while it is submitting or holds a code', () => {
	const restored = () => ({ mnemonicPhrase: C2_SAMPLE_PHRASE, beamio: { accountName: 'synthtag' }, profiles: [{ keyID: '0x0', privateKeyArmor: 'armor' }] })
	it('a new initialBeamioTag arriving while recoveryLoading is true keeps the recovery tab', async () => {
		let release: () => void = () => undefined
		const onRestore = jest.fn(() => new Promise<void>((resolve) => { release = resolve }))
		;(restoreWithRedeemDetailed as jest.Mock).mockResolvedValue({ kind: 'ok', temp: restored() })
		const view = render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={onRestore} initialBeamioTag="" />)
		fireEvent.click(screen.getAllByRole('button', { name: 'use_recovery_code' })[0])
		fireEvent.change(screen.getByPlaceholderText('enter_or_paste_your_code'), { target: { value: 'a1B2c3D4e5F6g7H8i9J0kL' } })
		fireEvent.submit(screen.getByPlaceholderText('enter_or_paste_your_code').closest('form') as HTMLFormElement)
		await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
		// still loading (onRestore pending): the parent now passes the recovered tag
		view.rerender(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={onRestore} initialBeamioTag="synthtag" />)
		// the progress is on screen (not the Unlock form)
		expect(screen.getByText('securing_your_identity')).toBeTruthy()
		expect(screen.queryByPlaceholderText('yourtag')).toBeNull()
		expect(screen.queryByText('unlock_your_beamio_id')).toBeNull()
		// when the loading ends without a parent switch (e.g. a failure), the screen is still on the recovery tab
		await act(async () => { release() })
		expect(screen.getByPlaceholderText('enter_or_paste_your_code')).toBeTruthy()
		expect(screen.queryByPlaceholderText('yourtag')).toBeNull()
		expect(screen.queryByText('unlock_your_beamio_id')).toBeNull()
	})
	it('a typed recovery code (not yet submitted) also keeps the recovery tab on a new initialBeamioTag', () => {
		const view = render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} initialBeamioTag="" />)
		fireEvent.click(screen.getAllByRole('button', { name: 'use_recovery_code' })[0])
		fireEvent.change(screen.getByPlaceholderText('enter_or_paste_your_code'), { target: { value: 'a1B2c3D4e5F6g7H8i9J0kL' } })
		view.rerender(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} initialBeamioTag="synthtag" />)
		expect(screen.getByPlaceholderText('enter_or_paste_your_code')).toBeTruthy()
	})
	it('regression: with no code and not loading, a known tag still prefills and opens Unlock', () => {
		const view = render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} initialBeamioTag="" />)
		fireEvent.click(screen.getAllByRole('button', { name: 'use_recovery_code' })[0])
		view.rerender(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} initialBeamioTag="synthtag" />)
		expect((screen.getByPlaceholderText('yourtag') as HTMLInputElement).value).toBe('synthtag')
	})
})

// item 6: the recovery code path shows the same two-phase progress as the password path. Each phase follows the real work
// (derivation, then wallet restore + verified persistence); there is no timer. After it the parent shows You're all set and enters /home once.
describe('two-phase restore progress that follows the real work (recovery code path)', () => {
	const restored = () => ({ mnemonicPhrase: C2_SAMPLE_PHRASE, beamio: { accountName: 'synthtag' }, profiles: [{ keyID: '0x0', privateKeyArmor: 'armor' }] })
	const CODE = 'a1B2c3D4e5F6g7H8i9J0kL'
	type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
	const deferred = <T,>(): Deferred<T> => {
		let resolve!: (v: T) => void
		let reject!: (e: unknown) => void
		const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
		return { promise, resolve, reject }
	}
	/** A step row: spinning icon = active, check icon = completed, neither = pending. */
	const stepState = (titleKey: string): 'active' | 'completed' | 'pending' => {
		const row = screen.getByText(titleKey).closest('div.flex.items-start') as HTMLElement
		if (row.querySelector('svg.animate-spin')) return 'active'
		if (row.querySelector('svg.lucide-check, svg[class*="22c55e"]')) return 'completed'
		return 'pending'
	}
	/** Parent stand-in for LoadingPage: onRestore -> You're all set -> one navigation to /home. */
	function Harness({ onRestore, goHome, derive }: { onRestore: (a: unknown) => Promise<void>; goHome: () => void; derive?: string }) {
		const React = require('react')
		const [done, setDone] = React.useState(false)
		const [tag, setTag] = React.useState('')
		if (done) return <button onClick={goHome}>YOURE_ALL_SET</button>
		return (
			<RestoreWalletUnifiedScreen
				onClose={jest.fn()}
				initialBeamioTag={tag}
				onRestore={async (a: unknown) => {
					setTag('synthtag') // init() stores the recovered tag mid-restore, as LoadingPage does
					await onRestore(a)
					setDone(true)
				}}
			/>
		)
	}
	const openRecoveryAndSubmit = () => {
		fireEvent.click(screen.getAllByRole('button', { name: 'use_recovery_code' })[0])
		fireEvent.change(screen.getByPlaceholderText('enter_or_paste_your_code'), { target: { value: CODE } })
		fireEvent.submit(screen.getByPlaceholderText('enter_or_paste_your_code').closest('form') as HTMLFormElement)
	}

	it('goes phase 1 (derivation) -> phase 2 (restore + persist) -> done page in order, never showing the Unlock form', async () => {
		jest.useFakeTimers()
		try {
			const derive = deferred<unknown>()
			const persist = deferred<void>()
			;(restoreWithRedeemDetailed as jest.Mock).mockReturnValue(derive.promise)
			const onRestore = jest.fn(() => persist.promise)
			const goHome = jest.fn()
			render(<Harness onRestore={onRestore} goHome={goHome} />)
			let unlockFormSeen = false
			const observer = new MutationObserver(() => { if (document.querySelector('[placeholder="yourtag"]')) unlockFormSeen = true })
			observer.observe(document.body, { childList: true, subtree: true })
			openRecoveryAndSubmit()
			// phase 1: derivation running, restore not started
			expect(screen.getByText('securing_your_identity')).toBeTruthy()
			expect(stepState('decrypting_your_secure_vault')).toBe('active')
			expect(stepState('restoring_wallet')).toBe('pending')
			expect(onRestore).not.toHaveBeenCalled()
			// no timer padding: a long wait does not move the phase
			await act(async () => { jest.advanceTimersByTime(60_000) })
			expect(stepState('decrypting_your_secure_vault')).toBe('active')
			expect(stepState('restoring_wallet')).toBe('pending')
			// derivation finishes -> phase 2 starts together with the restore + persistence
			await act(async () => { derive.resolve({ kind: 'ok', temp: restored() }) })
			expect(onRestore).toHaveBeenCalledTimes(1)
			expect(stepState('decrypting_your_secure_vault')).toBe('completed')
			expect(stepState('restoring_wallet')).toBe('active')
			await act(async () => { jest.advanceTimersByTime(60_000) })
			expect(stepState('restoring_wallet')).toBe('active')
			// persistence verified -> the parent shows You're all set
			await act(async () => { persist.resolve() })
			expect(screen.getByText('YOURE_ALL_SET')).toBeTruthy()
			expect(screen.queryByText('securing_your_identity')).toBeNull()
			expect(unlockFormSeen).toBe(false)
			observer.disconnect()
			expect(goHome).not.toHaveBeenCalled()
		} finally {
			jest.useRealTimers()
		}
	})

	it('a wrong code goes back to the recovery code form with the error, not to the Unlock form', async () => {
		;(restoreWithRedeemDetailed as jest.Mock).mockResolvedValue({ kind: 'invalid_code' })
		render(<Harness onRestore={jest.fn()} goHome={jest.fn()} />)
		openRecoveryAndSubmit()
		await waitFor(() => expect(screen.getByText('invalid_recovery_code')).toBeTruthy())
		expect(screen.getByPlaceholderText('enter_or_paste_your_code')).toBeTruthy()
		expect(screen.queryByPlaceholderText('yourtag')).toBeNull()
		expect(screen.queryByText('securing_your_identity')).toBeNull()
	})

	it('a failed restore/persist (onRestore throws) goes back to the recovery code form with the error, even after the recovered tag arrived', async () => {
		;(restoreWithRedeemDetailed as jest.Mock).mockResolvedValue({ kind: 'ok', temp: restored() })
		const onRestore = jest.fn(async () => { throw new Error('persist failed') })
		const goHome = jest.fn()
		render(<Harness onRestore={onRestore} goHome={goHome} />)
		openRecoveryAndSubmit()
		await waitFor(() => expect(screen.getByText('something_went_wrong_while_restoring_your_wallet')).toBeTruthy())
		expect(screen.getByPlaceholderText('enter_or_paste_your_code')).toBeTruthy()
		expect((screen.getByPlaceholderText('enter_or_paste_your_code') as HTMLInputElement).value).toBe(CODE)
		expect(screen.queryByPlaceholderText('yourtag')).toBeNull()
		expect(screen.queryByText('YOURE_ALL_SET')).toBeNull()
		expect(goHome).not.toHaveBeenCalled()
	})

	it('/home is entered once: a second submit during the progress is refused, onRestore runs once, one navigation', async () => {
		const derive = deferred<unknown>()
		;(restoreWithRedeemDetailed as jest.Mock).mockClear()
		;(restoreWithRedeemDetailed as jest.Mock).mockReturnValue(derive.promise)
		const onRestore = jest.fn(async () => undefined)
		const goHome = jest.fn()
		render(<Harness onRestore={onRestore} goHome={goHome} />)
		openRecoveryAndSubmit()
		// the form is replaced by the progress: a second submit cannot reach the form; the handler also refuses while loading
		expect(screen.queryByPlaceholderText('enter_or_paste_your_code')).toBeNull()
		await act(async () => { derive.resolve({ kind: 'ok', temp: restored() }) })
		await waitFor(() => expect(screen.getByText('YOURE_ALL_SET')).toBeTruthy())
		expect(restoreWithRedeemDetailed).toHaveBeenCalledTimes(1)
		expect(onRestore).toHaveBeenCalledTimes(1)
		fireEvent.click(screen.getByText('YOURE_ALL_SET'))
		expect(goHome).toHaveBeenCalledTimes(1)
	})

	it('the password path uses the same two phases (real work, no timer)', async () => {
		const derive = deferred<unknown>()
		const persist = deferred<void>()
		;(restoreWithUserPin as jest.Mock).mockReturnValue(derive.promise)
		const onRestore = jest.fn(() => persist.promise)
		render(<Harness onRestore={onRestore} goHome={jest.fn()} />)
		fireEvent.change(screen.getByPlaceholderText('yourtag'), { target: { value: 'synthtag' } })
		fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: 'Passw0rd-sample' } })
		fireEvent.submit(screen.getByPlaceholderText('yourtag').closest('form') as HTMLFormElement)
		expect(stepState('decrypting_your_secure_vault')).toBe('active')
		expect(stepState('restoring_wallet')).toBe('pending')
		await act(async () => { derive.resolve(restored()) })
		expect(stepState('decrypting_your_secure_vault')).toBe('completed')
		expect(stepState('restoring_wallet')).toBe('active')
		await act(async () => { persist.resolve() })
		expect(screen.getByText('YOURE_ALL_SET')).toBeTruthy()
	})
})
