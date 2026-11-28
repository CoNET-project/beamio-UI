/**
 * C-2 acceptance: the create-account screen (real component). Creating an account is not a recovery method: the
 * screen offers no recovery entry (unlock, recovery code), no mnemonic or private-key import and no mnemonic or key text box.
 * SYNTHETIC values only. The modules that touch the native bridge, the network and the workers are stubs.
 */
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
window.matchMedia = window.matchMedia || ((q: string) => ({ matches: false, media: q, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) as unknown as MediaQueryList)
;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || class { observe() {} unobserve() {} disconnect() {} }

import { render, screen } from '@testing-library/react'

jest.mock('@/locale/beamioLocale', () => ({ ...jest.requireActual('@/locale/beamioLocale'), tu: (key: string) => key, useTu: () => ({ tu: (key: string) => key, locale: 'en' }) }))
jest.mock('@/services/beamio', () => ({ checkBeamioAccountAPI: jest.fn(), createRecover: jest.fn(), LocalCreateError: class extends Error {} }))
jest.mock('@/services/nativeRecovery', () => ({
	nativeAccountCreateOpen: jest.fn(),
	nativeRecoveryOpen: jest.fn(),
	onNativeAccountCreateResult: () => () => undefined,
	onNativeRecoveryResult: () => () => undefined,
	recoveryOpenErrorKey: () => '',
}))
jest.mock('@/services/nativeWallet', () => ({ notifyNativeWalletReady: jest.fn(), reachNativeWallet: jest.fn(), rememberNativeEoa: jest.fn() }))
jest.mock('@/services/nativeWalletEstablished', () => ({ announceNativeWalletEstablished: jest.fn() }))
jest.mock('@/services/nativeFlowPending', () => ({ announceNativeFlowPending: jest.fn() }))
jest.mock('@/services/shellChatCapability', () => ({ ensureShellChatState: jest.fn(async () => 'native_chat') }))
jest.mock('@/services/shellContext', () => ({ isShellContext: () => (globalThis as { __shellCtx?: boolean }).__shellCtx === true }))
jest.mock('@/services/argon2WorkerBridge', () => ({ warmArgon2Worker: jest.fn() }))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
jest.mock('./RecoveryQRScreen', () => ({ getActivatingSteps: () => [] }))
jest.mock('./VerraFloatingNavChrome', () => ({ VerraFloatingNavChrome: () => null }))
jest.mock('@/components/IpfsImg', () => ({ IpfsImg: () => null }))
jest.mock('@/components/InvitedByIntroducerChip', () => ({ InvitedByIntroducerChip: () => null }))

// required after the polyfills above (the module reads TextEncoder when it loads)
const CreateUsernamePinScreen = require('./CreateUsernamePinScreen').default

describe('C-2: the create-account screen is not a recovery method', () => {
	it('renders its own entry only: no unlock, no recovery code, no import, no mnemonic or key box', () => {
		render(<CreateUsernamePinScreen close={jest.fn()} />)
		const labels = screen.getAllByRole('button').map((b: HTMLElement) => (b.textContent ?? '').trim())
		expect(labels).not.toContain('unlock')
		expect(labels).not.toContain('use_recovery_code')
		expect(labels.join('|')).not.toMatch(/mnemonic|phrase|private|import|seed|recovery/i)
		expect(document.querySelectorAll('textarea').length).toBe(0)
		for (const el of Array.from(document.querySelectorAll('input')) as HTMLElement[]) {
			const hint = `${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('name') ?? ''}`
			expect(hint.toLowerCase()).not.toMatch(/mnemonic|phrase|seed|private|recovery/)
		}
	})
})

describe('ordinary onboarding in a shell does not go through the old native entry', () => {
	afterEach(() => {
		;(globalThis as { __shellCtx?: boolean }).__shellCtx = false
	})
	it('mounting the create screen in a shell opens no native create, no native recovery and no native chat start', () => {
		;(globalThis as { __shellCtx?: boolean }).__shellCtx = true
		const nr = require('@/services/nativeRecovery')
		const cap = require('@/services/shellChatCapability')
		render(<CreateUsernamePinScreen close={jest.fn()} />)
		expect(nr.nativeAccountCreateOpen).not.toHaveBeenCalled()
		expect(nr.nativeRecoveryOpen).not.toHaveBeenCalled()
		expect(cap.ensureShellChatState).not.toHaveBeenCalled()
		expect(screen.getAllByRole('button').length).toBeGreaterThan(0)
	})
	it('the submit path has no native open either: the create handler runs the page create and has no call of the shell create (static; the screen is not driven to the end here)', () => {
		const src = require('fs').readFileSync(require('path').join(__dirname, 'CreateUsernamePinScreen.tsx'), 'utf8') as string
		const create = src.slice(src.indexOf('const handleCreateWallet'))
		expect(create).toContain('kks = await createRecover(')
		expect(create).not.toMatch(/handleShellCreate\(|nativeAccountCreateOpen\(|ensureShellChatState\(/)
	})
})
