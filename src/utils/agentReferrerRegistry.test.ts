/**
 * @jest-environment node
 *
 * Option A: the four registration functions in `agentReferrerRegistryClient.ts` return the unified
 * copy in a shell without the chat capability. They build no wallet, read no key and make no network call, and they do not
 * throw. The browser path (not blocked) keeps its previous behaviour. The module is loaded for real; its `@/` dependencies are
 * virtual stubs, because jest does not resolve the `@/` alias. SYNTHETIC values only: the key is a made-up hex string.
 */
import {
	registerAgentOnChain,
	registerMerchantUnderAgent,
	registerReferrerUnderIntroducer,
	registerTempUnderAgent,
} from '@/utils/agentReferrerRegistryClient'
import { resolveSigningPrivateKeyArmor } from '@/utils/resolveSigningPrivateKeyArmor'
import { conetDepinProvider } from '@/utils/constants'

// Synthetic test values. The key is a made-up hex string, not a real key.
const SYNTHETIC_KEY_HEX = '0x' + '5'.repeat(64)
const ADDR = '0x' + '22'.repeat(20)
const CARD = '0x' + '33'.repeat(20)
const UNIFIED = 'shell_chat_unavailable_body'
const ENGLISH_NO_KEY = 'Wallet signing key is not available'

// The shell state is a plain variable (the `mock` prefix lets the factory read it), so resetMocks does not clear it.
let mockBlocked = true

// The module under test is loaded for real, through its relative path, so the `@/` specifier resolves to it.
jest.mock('@/utils/agentReferrerRegistryClient', () => jest.requireActual('./agentReferrerRegistryClient'), { virtual: true })

jest.mock('@/config/chainAddresses', () => ({
	CONET_AGENT_REFERRER_REGISTRY: '0x' + '66'.repeat(20),
}), { virtual: true })

jest.mock('@/utils/constants', () => ({
	conetDepinProvider: { call: jest.fn(), send: jest.fn(), getNetwork: jest.fn() },
	beamioApi: 'https://api.invalid',
}), { virtual: true })

jest.mock('@/utils/resolveSigningPrivateKeyArmor', () => ({
	resolveSigningPrivateKeyArmor: jest.fn(() => ''),
}), { virtual: true })

jest.mock('@/utils/globals', () => ({
	CoNET_Data: { profiles: [] },
}), { virtual: true })

jest.mock('@/services/shellChatCapability', () => ({
	shellChatBlockedNow: () => mockBlocked,
}), { virtual: true })

jest.mock('@/locale/beamioLocale', () => ({
	tu: (key: string) => key,
}), { virtual: true })

const originalFetch = globalThis.fetch
const fetchSpy = jest.fn()

beforeEach(() => {
	mockBlocked = true
	fetchSpy.mockReset()
	globalThis.fetch = fetchSpy as unknown as typeof fetch
	// resetMocks clears implementations between tests, so the resolver answer is set again here: no key on this device
	;(resolveSigningPrivateKeyArmor as unknown as jest.Mock).mockReset().mockReturnValue('')
	;(conetDepinProvider.call as unknown as jest.Mock).mockReset()
	;(conetDepinProvider.send as unknown as jest.Mock).mockReset()
})

afterAll(() => {
	globalThis.fetch = originalFetch
})

function expectNothingBuilt(result: unknown) {
	expect(fetchSpy).not.toHaveBeenCalled()
	expect(conetDepinProvider.call).not.toHaveBeenCalled()
	expect(conetDepinProvider.send).not.toHaveBeenCalled()
	expect(resolveSigningPrivateKeyArmor).not.toHaveBeenCalled()
	expect(JSON.stringify(result)).not.toContain(SYNTHETIC_KEY_HEX.slice(2))
}

describe('the registration functions refuse in a shell without the chat capability', () => {
	it('registerReferrerUnderIntroducer: a key passed in is not used; the unified copy is returned and nothing is sent', async () => {
		const res = await registerReferrerUnderIntroducer(ADDR, SYNTHETIC_KEY_HEX, ADDR)
		expect(res).toEqual({ success: false, error: UNIFIED })
		expectNothingBuilt(res)
	})

	it('registerAgentOnChain: the unified copy is returned and nothing is sent', async () => {
		const res = await registerAgentOnChain()
		expect(res).toEqual({ success: false, error: UNIFIED })
		expectNothingBuilt(res)
	})

	it('registerTempUnderAgent: the unified copy is returned and nothing is sent', async () => {
		const res = await registerTempUnderAgent(ADDR)
		expect(res).toEqual({ success: false, error: UNIFIED })
		expectNothingBuilt(res)
	})

	it('registerMerchantUnderAgent: the unified copy is returned and nothing is sent, even with a temp account passed in', async () => {
		const res = await registerMerchantUnderAgent(ADDR, CARD, ADDR)
		expect(res).toEqual({ success: false, error: UNIFIED })
		expectNothingBuilt(res)
	})
})

describe('the browser path is unchanged', () => {
	it('with no key and no blocked shell, the registrations keep the previous key error and send nothing', async () => {
		mockBlocked = false
		expect(await registerAgentOnChain()).toEqual({ success: false, error: ENGLISH_NO_KEY })
		expect(await registerTempUnderAgent(ADDR)).toEqual({ success: false, error: ENGLISH_NO_KEY })
		expect(await registerMerchantUnderAgent(ADDR, CARD, ADDR)).toEqual({ success: false, error: ENGLISH_NO_KEY })
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(resolveSigningPrivateKeyArmor).toHaveBeenCalled()
	})
})
