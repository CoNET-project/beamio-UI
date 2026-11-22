/**
 * (approach a′) and : a key-only account makes no AA ensure (the GET to /api/ensureAAForEOAOnConet) and no bind call
 * (the stashed referrer and share-referee binds). The control cases show that the same profile does make these calls when the
 * account is not key-only, so the zero-call result is not a broken harness. The home footer and its search stay visible for the
 * key-only account. The real hook runs; only the write functions and the browser fetch are mocked. SYNTHETIC values only.
 */
import { render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useAccountBindEffects } from './useAccountBindEffects'
import { ensureConetAaForProfileAndPersist } from '@/utils/ensureConetAa'
import { bindStashedAgentInviteReferrerIfNeeded } from '@/utils/agentInviteReferrerBind'
import { bindStashedShareRefereesIfNeeded } from '@/utils/discoverShareClickEvent'
import Footer from '@/components/Footer'

jest.mock('@/utils/ensureConetAa', () => ({ ensureConetAaForProfileAndPersist: jest.fn(async () => undefined) }))
jest.mock('@/utils/agentInviteReferrerBind', () => ({ bindStashedAgentInviteReferrerIfNeeded: jest.fn(async () => undefined) }))
jest.mock('@/utils/discoverShareClickEvent', () => ({ bindStashedShareRefereesIfNeeded: jest.fn(async () => undefined) }))
jest.mock('@/utils/discoverShareReferrerStash', () => ({ DISCOVER_SHARE_REFERRER_STASHED_EVENT: 'test:discover-share-referrer-stashed' }))
jest.mock('@/utils/agentInviteIntroducerStash', () => ({ AGENT_INVITE_INTRODUCER_STASHED_EVENT: 'test:agent-invite-stashed' }))
jest.mock('@/utils/resolveSigningPrivateKeyArmor', () => ({
	resolveSigningPrivateKeyArmor: (p?: { privateKeyArmor?: string }) => (p?.privateKeyArmor ?? '').trim(),
}))
jest.mock('@/providers/DaemonProvider', () => ({
	useDaemonContext: () => ({
		hasNewVersion: false,
		darkModle: false,
		isInitialLoading: false,
		messageCount: 0,
		setMessageCount: jest.fn(),
		setShowFooter: jest.fn(),
		setChatSearchOpen: jest.fn(),
	}),
}))
jest.mock('@/locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('@/services/beamio', () => ({}))
jest.mock('@/utils/globals', () => ({}))

// Synthetic test values: a second address for the AA, and a placeholder key string (the resolver mock returns it).
// EOA is the address derived from the public BIP-39 test vector (abandon … about), so the account fixtures below are valid accounts.
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const AA = '0x2222222222222222222222222222222222222222'
const KEY = `0x${'11'.repeat(32)}`

/** A key-only profile: private key present, no mnemonic, no AA recorded yet. */
const noAaProfile = () => [{ keyID: EOA, privateKeyArmor: KEY }]
/** The same profile with an AA that differs from the EOA: the share-referee bind is the path that runs. */
const withAaProfile = () => [{ keyID: EOA, aaAccount: AA, privateKeyArmor: KEY }]
/** Control fixtures: a valid account (mnemonic whose derived EOA equals keyID), so the zero-call result is not a key-only artefact. */
const accountNoAaProfile = () => [{ keyID: EOA, mnemonicPhrase: PHRASE, privateKeyArmor: KEY }]
const accountWithAaProfile = () => [{ keyID: EOA, aaAccount: AA, mnemonicPhrase: PHRASE, privateKeyArmor: KEY }]

const ensureAa = ensureConetAaForProfileAndPersist as unknown as jest.Mock
const bindInvite = bindStashedAgentInviteReferrerIfNeeded as unknown as jest.Mock
const bindShare = bindStashedShareRefereesIfNeeded as unknown as jest.Mock

function runHook(profiles: unknown[], keyOnlyEntered: boolean) {
	return renderHook(
		(props: { keyOnlyEntered: boolean }) =>
			useAccountBindEffects({
				isInitialLoading: false,
				profiles: profiles as never,
				setProfiles: jest.fn() as never,
				keyOnlyEntered: props.keyOnlyEntered,
			}),
		{ initialProps: { keyOnlyEntered } },
	)
}

describe('a key-only account makes no AA ensure and no bind call (a′)', () => {
	let fetchSpy: jest.Mock

	beforeEach(() => {
		jest.clearAllMocks()
		fetchSpy = jest.fn(async () => ({ ok: true, json: async () => ({}) }))
		;(global as unknown as { fetch: jest.Mock }).fetch = fetchSpy
	})

	it('key-only: no AA ensure, no invite bind, no share bind, and no fetch', () => {
		runHook(noAaProfile(), true)
		runHook(withAaProfile(), true)
		expect(ensureAa).not.toHaveBeenCalled()
		expect(bindInvite).not.toHaveBeenCalled()
		expect(bindShare).not.toHaveBeenCalled()
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('control, not key-only: the same profile makes the AA ensure and the invite bind', () => {
		runHook(accountNoAaProfile(), false)
		expect(ensureAa).toHaveBeenCalledTimes(1)
		expect(bindInvite).toHaveBeenCalledWith(EOA)
	})

	it('control, not key-only: a profile with a differing AA makes the share-referee bind', () => {
		runHook(accountWithAaProfile(), false)
		expect(bindShare).toHaveBeenCalledWith(KEY)
	})

	it('key-only home: the footer and its search are visible, and the account effects stay silent', () => {
		function Home() {
			useAccountBindEffects({
				isInitialLoading: false,
				profiles: withAaProfile() as never,
				setProfiles: jest.fn() as never,
				keyOnlyEntered: true,
			})
			return <Footer visible />
		}
		render(
			<MemoryRouter initialEntries={['/']}>
				<Home />
			</MemoryRouter>,
		)
		const search = screen.getByRole('button', { name: 'search' }) as HTMLButtonElement
		expect(search.disabled).toBe(false)
		expect(ensureAa).not.toHaveBeenCalled()
		expect(bindInvite).not.toHaveBeenCalled()
		expect(bindShare).not.toHaveBeenCalled()
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
