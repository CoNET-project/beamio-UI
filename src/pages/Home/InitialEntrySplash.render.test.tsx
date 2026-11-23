/**
 * Y.163 / 1428: the real onboarding splash (InitialEntrySplash, not a stand-in). The create entry (Get Started, create a mnemonic)
 * and the restore entry are both rendered on the not_ready onboarding; the three 1428 onboarding paths are reachable from them:
 * create a mnemonic (Get Started), recovery code (RestoreWalletUnifiedScreen, Use Recovery Code), username and password (its unlock screen).
 */
window.matchMedia = window.matchMedia || ((q: string) => ({ matches: false, media: q, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) as unknown as MediaQueryList)
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || ResizeObserverStub
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })

import { render, screen } from '@testing-library/react'
const { InitialEntrySplash } = require('./LoadingPage') as typeof import('./LoadingPage')


jest.mock('@/locale/beamioLocale', () => ({ ...jest.requireActual('@/locale/beamioLocale'), tu: (key: string) => key, useTu: () => ({ tu: (key: string) => key, locale: 'en' }) }))

jest.mock('@/workers/beamioTag/client', () => ({}))
jest.mock('@/workers/appDaemon/client', () => ({}))
jest.mock('@/services/chatWorkerBridge', () => ({}))
jest.mock('@/services/argon2WorkerBridge', () => ({}))
jest.mock('@/services/chatMediaWorkerBridge', () => ({}))
jest.mock('openpgp', () => ({}))
jest.mock('pdfjs-dist', () => ({}))
jest.mock('pdfjs-dist/legacy/build/pdf', () => ({}))

describe('onboarding splash (real component): the create and restore entries', () => {
	it('renders Get Started (create a mnemonic) and the restore entry', () => {
		render(<InitialEntrySplash appVersion="0.53.16" isStandalone={false} onGetStarted={jest.fn()} onRestoreWallet={jest.fn()} />)
		expect(screen.getByText('get_started')).toBeTruthy()
		expect(screen.getByText('unlock_wallet')).toBeTruthy()
	})
})
