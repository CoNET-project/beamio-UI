/**
 * @jest-environment node
 *
 * Option A: the identity services send nothing and read no key in a shell without the chat
 * capability, and they do not throw. Each service is loaded for real; its `@/` dependencies are virtual stubs, because jest
 * does not resolve the `@/` alias. SYNTHETIC values only: the key below is a made-up hex string, not a real key.
 */
import { ethers } from 'ethers'
import { setShellChatUiState } from './shellChatUiState'
import { signAndSubmitBusinessStartKetRedeemCreate } from './businessStartKetRedeem'
import {
	signAndSubmitValidatorDepositRedeemCancel,
	signAndSubmitValidatorDepositRedeemCreate,
} from './validatorDepositRedeemAdmin'
import {
	releaseValidatorDepositRedeemAirdropSelf,
	signAndSubmitValidatorDepositRedeemClaimAirdrop,
} from './validatorDepositRedeemAirdrop'
import { signAndSubmitValidatorDepositRedeemClaim } from './validatorDepositRedeemClaim'
import { bindStashedAgentInviteReferrerIfNeeded } from '../utils/agentInviteReferrerBind'
import { syncChatBadgeToApi } from '../utils/cashTreesPushBind'
import { completeDiscoverUsdcTopupBeneficiary } from '../utils/discoverUsdcTopupSession'
import { resolveSessionEoa } from '../utils/resolveSessionEoa'
import { routeDiscoverMerchantDeepLink } from '../utils/routeDiscoverMerchantDeepLink'
// Helpers are imported through the same `@/` specifiers the services use, so they are the virtual stubs below.
import { registerReferrerUnderIntroducer } from '@/utils/agentReferrerRegistryClient'
import { bindStashedShareRefereesIfNeeded } from '@/utils/discoverShareClickEvent'
import { rememberPendingDiscoverMerchantIntentFor } from '@/utils/discoverMerchantShare'
import { clearAgentInviteIntroducer } from '@/utils/agentInviteIntroducerStash'
import { postWorkerOwnMailboxCommand } from '@/services/chatWorkerBridge'
import { signExecuteForAdmin } from '@/utils/signExecuteForAdmin'

// Synthetic test values. The key is a made-up hex string, not a real key.
const SYNTHETIC_KEY_HEX = '0x' + '5'.repeat(64)
const ADDR = '0x' + '22'.repeat(20)
const CODE_HASH = '0x' + '11'.repeat(32)

// Virtual stubs for the `@/` modules the services import. The shell flag is a plain variable (the `mock` prefix lets the
// factory read it), so resetMocks does not clear it.
let mockShell = true

jest.mock('@/config/chainAddresses', () => ({
	CONET_BUSINESS_START_KET_REDEEM: '0x' + '33'.repeat(20),
	CONET_MAINNET_CHAIN_ID: 224400,
	CONET_VALIDATOR_DEPOSIT_REDEEM: '0x' + '44'.repeat(20),
	CONET_GUARDIAN_NODES_INFO_V6: '0x' + '55'.repeat(20),
	CONET_AGENT_REFERRER_REGISTRY: '0x' + '66'.repeat(20),
}), { virtual: true })

jest.mock('@/utils/constants', () => ({
	conetDepinProvider: {},
	beamioApi: 'https://api.invalid',
	baseEndpoint: 'https://base.invalid',
}), { virtual: true })

// The real modules that other service modules import through the `@/` alias are mapped to the actual files.
jest.mock('@/services/validatorDepositRedeemAdmin', () => jest.requireActual('./validatorDepositRedeemAdmin'), { virtual: true })
jest.mock('@/utils/agentReferrerRegistryClient', () => jest.requireActual('../utils/agentReferrerRegistryClient'), { virtual: true })

// Blocked shell: the resolver answers with no key, as the real resolver does when the capability is missing.
jest.mock('@/utils/resolveSigningPrivateKeyArmor', () => ({
	resolveSigningPrivateKeyArmor: () => '',
}), { virtual: true })

jest.mock('@/locale/beamioLocale', () => ({
	tu: (key: string) => key,
}), { virtual: true })

// The real capability guard (Chat SDK): it reads the shell UI state set in each test, and the shell flag below.
jest.mock('@/services/shellChatCapability', () => jest.requireActual('../services/shellChatCapability'), { virtual: true })

jest.mock('@/services/shellContext', () => ({
	isShellContext: () => mockShell,
}), { virtual: true })
jest.mock('./shellContext', () => ({
	isShellContext: () => mockShell,
}))

jest.mock('@/utils/globals', () => ({
	CoNET_Data: { profiles: [{ keyID: '0x' + '22'.repeat(20) }] },
}), { virtual: true })

jest.mock('@/utils/cashTreesNativeNfc', () => ({
	getCashTreesNativeNfcHost: () => null,
	isCashTreesNativeWebView: () => true,
}), { virtual: true })

jest.mock('@/services/chatWorkerBridge', () => ({
	postWorkerOwnMailboxCommand: jest.fn(),
}), { virtual: true })

jest.mock('@/services/ownPgpPublic', () => ({
	cachedOwnPgpPublic: () => null,
	loadOwnPgpPublicMaterial: jest.fn(),
}), { virtual: true })

jest.mock('@/services/beamio', () => ({}), { virtual: true })

jest.mock('@/utils/signExecuteForAdmin', () => ({
	signExecuteForAdmin: jest.fn(),
}), { virtual: true })

jest.mock('@/utils/discoverEoaUsdcTopup', () => ({
	eoaCanSelfFundDiscoverTopup: jest.fn(),
	readEoaUsdcBalance6: jest.fn(),
}), { virtual: true })

jest.mock('@/utils/usdcChargeSessionApi', () => ({
	fetchUsdcChargeSession: jest.fn(),
	submitUsdcChargeTopupAuth: jest.fn(),
}), { virtual: true })

jest.mock('@/utils/agentInviteIntroducerStash', () => ({
	clearAgentInviteIntroducer: jest.fn(),
	readAgentInviteIntroducer: () => '0x' + '77'.repeat(20),
	stashAgentInviteIntroducerFromCurrentUrl: () => undefined,
}), { virtual: true })

jest.mock('@/utils/discoverShareReferrerStash', () => ({
	stashDiscoverShareReferrer: jest.fn(),
}), { virtual: true })

jest.mock('@/utils/discoverShareClickEvent', () => ({
	bindStashedShareRefereesIfNeeded: jest.fn(),
}), { virtual: true })

jest.mock('@/utils/discoverMerchantShare', () => ({
	rememberPendingDiscoverMerchantIntentFor: jest.fn(),
	stripDiscoverMerchantDeepLinkParams: jest.fn(),
}), { virtual: true })

const originalFetch = globalThis.fetch
const fetchSpy = jest.fn()

beforeEach(() => {
	mockShell = true
	setShellChatUiState('chat_unavailable')
	fetchSpy.mockReset()
	globalThis.fetch = fetchSpy as unknown as typeof fetch
	// `window` is needed by the push path (syncChatBadgeToApi returns early without it); its timers are the Node ones
	;(globalThis as unknown as { window: object }).window = globalThis
	jest.clearAllMocks()
})

afterAll(() => {
	globalThis.fetch = originalFetch
	delete (globalThis as unknown as { window?: object }).window
})

function expectNoSend(result: unknown) {
	expect(fetchSpy).not.toHaveBeenCalled()
	expect(JSON.stringify(result)).not.toContain(SYNTHETIC_KEY_HEX.slice(2))
}

describe('identity services refuse in a shell without the chat capability', () => {
	it('businessStartKetRedeem: create returns the unified error and sends nothing, even with a key passed in', async () => {
		const res = await signAndSubmitBusinessStartKetRedeemCreate({
			adminEoa: ADDR,
			codeHash: CODE_HASH,
			buintAmount6: 1n,
			privateKeyArmor: SYNTHETIC_KEY_HEX,
		})
		expect(res).toEqual({ success: false, error: 'shell_chat_unavailable_body' })
		expectNoSend(res)
	})

	it('validatorDepositRedeemAdmin: create and cancel return the unified error and send nothing', async () => {
		const created = await signAndSubmitValidatorDepositRedeemCreate({
			adminEoa: ADDR,
			codeHash: CODE_HASH,
			validatorCount: 1,
			targetNodeIp: '10.0.0.1',
			gbMiningNodeCount: 1,
			privateKeyArmor: SYNTHETIC_KEY_HEX,
		})
		const cancelled = await signAndSubmitValidatorDepositRedeemCancel({
			adminEoa: ADDR,
			codeHash: CODE_HASH,
			privateKeyArmor: SYNTHETIC_KEY_HEX,
		})
		expect(created).toEqual({ success: false, error: 'shell_chat_unavailable_body' })
		expect(cancelled).toEqual({ success: false, error: 'shell_chat_unavailable_body' })
		expectNoSend(created)
		expectNoSend(cancelled)
	})

	it('validatorDepositRedeemAirdrop: claim and release return the unified error and send nothing', async () => {
		const claim = await signAndSubmitValidatorDepositRedeemClaimAirdrop({
			beneficiaryEoa: ADDR,
			privateKeyArmor: SYNTHETIC_KEY_HEX,
		})
		const release = await releaseValidatorDepositRedeemAirdropSelf({
			beneficiaryEoa: ADDR,
			privateKeyArmor: SYNTHETIC_KEY_HEX,
		})
		expect(claim).toEqual({ success: false, error: 'shell_chat_unavailable_body' })
		expect(release).toEqual({ success: false, error: 'shell_chat_unavailable_body' })
		expectNoSend(claim)
		expectNoSend(release)
	})

	it('validatorDepositRedeemClaim: claim returns the unified error before the preview read, so nothing is sent', async () => {
		const res = await signAndSubmitValidatorDepositRedeemClaim({
			claimerEoa: ADDR,
			secretCode: 'SYNTHETIC-CODE',
			privateKeyArmor: SYNTHETIC_KEY_HEX,
		})
		expect(res).toEqual({ success: false, error: 'shell_chat_unavailable_body' })
		expectNoSend(res)
	})

	it('agentReferrerRegistryClient: a key passed in builds no wallet, so the registration returns the unified error and sends nothing', async () => {
		const res = await registerReferrerUnderIntroducer(ADDR, SYNTHETIC_KEY_HEX, ADDR)
		// The shell check comes first, so the unified copy is returned before any wallet is built (an earlier version returned the English key error)
		expect(res).toEqual({ success: false, error: 'shell_chat_unavailable_body' })
		expectNoSend(res)
	})

	it('agentInviteReferrerBind: with no signing key the bind sends nothing, keeps the introducer and does not throw', async () => {
		await expect(bindStashedAgentInviteReferrerIfNeeded(ADDR)).resolves.toBeUndefined()
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(clearAgentInviteIntroducer).not.toHaveBeenCalled()
	})

	it('cashTreesPushBind: the badge sync signs nothing and sends nothing without a key, and does not throw', async () => {
		await expect(syncChatBadgeToApi(3)).resolves.toBeUndefined()
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(postWorkerOwnMailboxCommand).not.toHaveBeenCalled()
	})

	it('discoverUsdcTopupSession: the beneficiary completion refuses in a shell and signs nothing', async () => {
		const res = await completeDiscoverUsdcTopupBeneficiary({
			cardAddress: ADDR,
			amount: '1',
			currency: 'USD',
			wallet: ADDR,
			usdcTopupSessionId: 'sid',
			profile: { privateKeyArmor: SYNTHETIC_KEY_HEX, keyID: ADDR } as never,
		})
		expect(res.success).toBe(false)
		expect(signExecuteForAdmin).not.toHaveBeenCalled()
		expectNoSend(res)
	})

	it('resolveSessionEoa: the session EOA is the keyID, never the address derived from a key passed in', () => {
		const eoa = resolveSessionEoa([{ keyID: ADDR, privateKeyArmor: SYNTHETIC_KEY_HEX }])
		expect(eoa).toBe(ethers.getAddress(ADDR))
		expect(eoa).not.toBe(new ethers.Wallet(SYNTHETIC_KEY_HEX).address)
	})

	it('routeDiscoverMerchantDeepLink: no bind of share referees without a key; the intent is kept and the route still opens', () => {
		const navigate = jest.fn()
		routeDiscoverMerchantDeepLink({
			cardAddress: ADDR,
			profile: { privateKeyArmor: SYNTHETIC_KEY_HEX },
			navigate: navigate as never,
		})
		expect(bindStashedShareRefereesIfNeeded).not.toHaveBeenCalled()
		expect(rememberPendingDiscoverMerchantIntentFor).toHaveBeenCalledWith(ADDR, null)
		expect(navigate).toHaveBeenCalledWith('/discover', expect.any(Object))
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})

/**
 * Positive cases (/ Chat SDK): the guard blocks only in a shell without the capability. With the
 * capability, or in a browser build, the same calls reach the signing path, so the unified copy is not returned.
 */
describe('the guard does not block with the capability or in a browser', () => {
	it('with the capability (native_chat in a shell), the create is not refused with the unified copy', async () => {
		setShellChatUiState('native_chat')
		mockShell = true
		const res = await signAndSubmitBusinessStartKetRedeemCreate({
			adminEoa: ADDR,
			codeHash: CODE_HASH,
			buintAmount6: 1n,
			privateKeyArmor: SYNTHETIC_KEY_HEX,
		})
		expect(JSON.stringify(res)).not.toContain('shell_chat_unavailable_body')
	})

	it('with the capability (native_chat in a shell), the validator create and cancel are not refused with the unified copy', async () => {
		setShellChatUiState('native_chat')
		mockShell = true
		const created = await signAndSubmitValidatorDepositRedeemCreate({
			adminEoa: ADDR,
			codeHash: CODE_HASH,
			validatorCount: 1,
			targetNodeIp: '10.0.0.1',
			gbMiningNodeCount: 1,
			privateKeyArmor: SYNTHETIC_KEY_HEX,
		})
		const cancelled = await signAndSubmitValidatorDepositRedeemCancel({
			adminEoa: ADDR,
			codeHash: CODE_HASH,
			privateKeyArmor: SYNTHETIC_KEY_HEX,
		})
		expect(JSON.stringify(created)).not.toContain('shell_chat_unavailable_body')
		expect(JSON.stringify(cancelled)).not.toContain('shell_chat_unavailable_body')
	})

	it('in a browser build (not a shell), the create is not refused with the unified copy, even with the chat state unavailable', async () => {
		setShellChatUiState('chat_unavailable')
		mockShell = false
		const res = await signAndSubmitBusinessStartKetRedeemCreate({
			adminEoa: ADDR,
			codeHash: CODE_HASH,
			buintAmount6: 1n,
			privateKeyArmor: SYNTHETIC_KEY_HEX,
		})
		expect(JSON.stringify(res)).not.toContain('shell_chat_unavailable_body')
	})
})
