/**
 * @jest-environment node
 *
 * G2 batch 5 (spec, option A): the release button and the agent registration entries show the unified copy, and
 * register, create or unlock nothing, in a shell without the chat capability. These are static guards: the sources are read,
 * so a removed guard fails this test. The behaviour of the four registration functions is covered by
 * `src/utils/agentReferrerRegistryBatch5.test.ts`.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

const UNIFIED_KEY = 'shell_chat_unavailable_body'
const HOOK_IMPORT = "import { useIdentityEntryDisabled } from '@/hooks/useIdentityEntryDisabled'"
const HOOK_CALL = 'const identityEntryDisabled = useIdentityEntryDisabled()'

/** Every occurrence of `call` is preceded, within `window` characters, by `guard`. Returns how many occurrences there were. */
function everyCallGuarded(src: string, call: string, guard: string, window = 160): number {
	let count = 0
	let at = src.indexOf(call)
	while (at >= 0) {
		count += 1
		expect(src.slice(Math.max(0, at - window), at)).toContain(guard)
		at = src.indexOf(call, at + 1)
	}
	return count
}

describe('the release and agent registration entries refuse in a shell without the chat capability', () => {
	it('GenesisLoyaltyVestingSheet: the button is disabled, and the release handler refuses before the English prompt and the service call', () => {
		const src = read('components/BountyBoard/GenesisLoyaltyVestingSheet.tsx')
		expect(src).toContain(HOOK_IMPORT)
		expect(src).toContain(HOOK_CALL)
		expect(src).toContain('&& !identityEntryDisabled')
		const at = src.indexOf('const handleRelease = useCallback(async () => {')
		const guard = src.indexOf('if (shellChatBlockedNow()) {', at)
		const english = src.indexOf("showBeamioToast('Unlock your wallet to claim the airdrop.')", at)
		const call = src.indexOf('releaseValidatorDepositRedeemAirdropSelf({', at)
		expect(at).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(at)
		expect(src.slice(guard, guard + 140)).toContain(`showBeamioToastError(tu('${UNIFIED_KEY}'))`)
		// the English prompt is only reached on the browser path, after the shell guard
		expect(english).toBeGreaterThan(guard)
		expect(call).toBeGreaterThan(guard)
		// the helper line under the button shows the unified copy in a blocked shell
		expect(src).toContain(`{identityEntryDisabled\n`)
		expect(src).toContain(`? tu('${UNIFIED_KEY}')`)
	})

	it('AgentBusinessInviteSheet: the status check, the temp and handoff registrations, the refresh and the create refuse in a blocked shell', () => {
		const src = read('pages/BountyBoard/AgentBusinessInviteSheet.tsx')
		expect(src).toContain(HOOK_IMPORT)
		expect(src).toContain(HOOK_CALL)
		expect(src).toContain("import { shellChatBlockedNow } from '@/services/shellChatCapability'")
		expect(src).toContain("import { tu } from '@/locale/beamioLocale'")

		// status check: the blocked branch sets the unified status error and returns before the agent registration
		const statusAt = src.indexOf("if (!open || !agentEoa) return")
		const statusGuard = src.indexOf('if (identityEntryDisabled) {', statusAt)
		const statusRegister = src.indexOf('await registerAgentOnChain()', statusAt)
		expect(statusAt).toBeGreaterThan(0)
		expect(statusGuard).toBeGreaterThan(statusAt)
		expect(src.slice(statusGuard, statusGuard + 160)).toContain(`setStatusError(tu('${UNIFIED_KEY}'))`)
		expect(statusRegister).toBeGreaterThan(statusGuard)

		// temp registration effect: returns before the temp and merchant registrations
		const effectAt = src.indexOf("if (!open || agentState !== 'agent') return")
		const effectGuard = src.indexOf('if (identityEntryDisabled) return', effectAt)
		expect(effectAt).toBeGreaterThan(0)
		expect(effectGuard).toBeGreaterThan(effectAt)
		expect(src.indexOf('void registerTempUnderAgent(temp.eoa)', effectAt)).toBeGreaterThan(effectGuard)
		expect(src.indexOf('await registerMerchantUnderAgent(row.owner, row.cardAddress, temp.eoa)', effectAt)).toBeGreaterThan(effectGuard)

		// refresh: the card list still loads, the handoff registration is skipped in a blocked shell
		const refreshAt = src.indexOf('const refreshCards = async (temp: AgentTempAccount) => {')
		const refreshGuard = src.indexOf('if (shellChatBlockedNow()) return', refreshAt)
		expect(refreshAt).toBeGreaterThan(0)
		expect(refreshGuard).toBeGreaterThan(refreshAt)
		expect(src.indexOf('await registerMerchantUnderAgent(row.owner, row.cardAddress, temp.eoa)', refreshAt)).toBeGreaterThan(refreshGuard)

		// create: the guard shows the unified copy and returns before the busy flag and the create call
		const addAt = src.indexOf('const addTemp = async () => {')
		const addGuard = src.indexOf('if (shellChatBlockedNow()) {', addAt)
		expect(addAt).toBeGreaterThan(0)
		expect(addGuard).toBeGreaterThan(addAt)
		expect(src.slice(addGuard, addGuard + 120)).toContain(`setCreateError(tu('${UNIFIED_KEY}'))`)
		expect(src.indexOf('setCreating(true)', addAt)).toBeGreaterThan(addGuard)
		expect(src.indexOf('await createAgentTempAccount(agentEoa)', addAt)).toBeGreaterThan(addGuard)

		// the add button is disabled in a blocked shell
		expect(src).toContain('|| atTempCap || identityEntryDisabled}')
	})

	it('MerchantsBusinessPanel: the refresh and the temp effect register nothing in a blocked shell; the View Business OS link shows the unified copy', () => {
		const src = read('pages/BountyBoard/MerchantsBusinessPanel.tsx')
		expect(src).toContain(HOOK_IMPORT)
		expect(src).toContain(HOOK_CALL)
		expect(src).toContain("import { shellChatBlockedNow } from '@/services/shellChatCapability'")
		expect(src).toContain("import { tu } from '@/locale/beamioLocale'")

		// every registration call in the panel is guarded (refresh: shellChatBlockedNow; effect: the hook value)
		expect(everyCallGuarded(src, 'void registerMerchantUnderAgent(', 'if (!')).toBe(2)
		expect(src).toContain('if (!shellChatBlockedNow()) void registerMerchantUnderAgent(row.owner, row.cardAddress, temp.eoa)')
		expect(src).toContain('if (!identityEntryDisabled) void registerMerchantUnderAgent(row.owner, row.cardAddress, temp.eoa).catch(')
		expect(src).toContain('if (!identityEntryDisabled) void registerTempUnderAgent(temp.eoa).catch(() => undefined)')
		// the link registers only when the shell is not blocked, and the passcode never goes into the link
		expect(src).toContain('if (!blocked) void registerTempUnderAgent(temp.eoa).catch(() => undefined)')
		expect(src).toContain('}, [temps, agentEoa, tempsRefreshKey, identityEntryDisabled])')

		// the link: the unified copy replaces it in a blocked shell; the click handler refuses before it unlocks a temp key
		expect(src).toContain(`{identityEntryDisabled ? (`)
		expect(src).toContain(`{tu('${UNIFIED_KEY}')}`)
		const linkAt = src.indexOf('View Business OS')
		const clickGuard = src.lastIndexOf('const blocked = shellChatBlockedNow()', linkAt)
		const helperCall = src.lastIndexOf('void openMerchantOsForTemp({', linkAt)
		expect(linkAt).toBeGreaterThan(0)
		expect(clickGuard).toBeGreaterThan(src.lastIndexOf('e.preventDefault()', linkAt))
		expect(helperCall).toBeGreaterThan(clickGuard)
		expect(src.slice(helperCall, helperCall + 200)).toContain('blocked,')
		expect(src).not.toContain('while (Date.now() < deadline)')
		expect(src).not.toMatch(/href=\{merchantOsUnlockUrl/)
	})

	it('AgentTempAccountStates: both Open Business OS buttons and the handoff button are disabled, and the handlers refuse before the key or the register call', () => {
		const src = read('pages/BountyBoard/AgentTempAccountStates.tsx')
		expect(src).toContain(HOOK_IMPORT)
		expect(src).toContain(HOOK_CALL)
		expect(src).toContain("import { shellChatBlockedNow } from '@/services/shellChatCapability'")
		expect(src).toContain("import { tu } from '@/locale/beamioLocale'")

		// openBusinessOs: the guard precedes the register call and the temp key unlock
		const osAt = src.indexOf("const openBusinessOs = async (flow?: 'business') => {")
		const osGuard = src.indexOf('if (shellChatBlockedNow()) {', osAt)
		expect(osAt).toBeGreaterThan(0)
		expect(osGuard).toBeGreaterThan(osAt)
		expect(src.slice(osGuard, osGuard + 120)).toContain(`setClaimError(tu('${UNIFIED_KEY}'))`)
		expect(src.indexOf('await registerTempUnderAgent(temp.eoa)', osAt)).toBeGreaterThan(osGuard)
		expect(src.indexOf('unlockDetachedRecoverPrivateKey(temp.beamioTag, temp.accessPassword)', osAt)).toBeGreaterThan(osGuard)
		// no polling for the temp key, and no passcode in any link
		expect(src).not.toContain('while (Date.now() < deadline)')
		expect(src).not.toContain('tempPk')

		// the owner handover entry is removed; no owner link is built and no temp key goes into a link.
		expect(src).not.toContain('openHandoff')
		expect(src).not.toContain('buildAgentCardClaimUrlForTemp')

		// the buttons
		expect(src.split('disabled={identityEntryDisabled}').length - 1).toBeGreaterThanOrEqual(2)
	})

	it('agentBusinessWorkspace: createAgentTempAccount refuses before any local account is made, stored or bound; the claim refuses before the key unlock', () => {
		const src = read('utils/agentBusinessWorkspace.ts')
		expect(src).toContain("import { shellChatBlockedNow } from '@/services/shellChatCapability'")
		expect(src).toContain("import { tu } from '@/locale/beamioLocale'")

		const createAt = src.indexOf('export async function createAgentTempAccount(')
		const createGuard = src.indexOf('if (shellChatBlockedNow()) throw new Error(', createAt)
		expect(createAt).toBeGreaterThan(0)
		expect(createGuard).toBeGreaterThan(createAt)
		expect(src.slice(createGuard, createGuard + 120)).toContain(`tu('${UNIFIED_KEY}')`)
		// the  shell refusal is kept after the capability guard, so the static  test still sees it
		expect(src.indexOf('isShellContext()', createAt)).toBeGreaterThan(createGuard)
		expect(src.indexOf('createDetachedRecoverAccount(beamioTag', createAt)).toBeGreaterThan(createGuard)
		expect(src.indexOf('saveAgentTempAccounts(agentEoa, temps)', createAt)).toBeGreaterThan(createGuard)
		expect(src.indexOf('await registerTempUnderAgent(record.eoa)', createAt)).toBeGreaterThan(createGuard)

		const claimAt = src.indexOf('export async function claimTempCreateMerchantCardNft(')
		const claimGuard = src.indexOf('if (shellChatBlockedNow()) return { ok: false, error: tu(', claimAt)
		expect(claimAt).toBeGreaterThan(0)
		expect(claimGuard).toBeGreaterThan(claimAt)
		expect(src.slice(claimGuard, claimGuard + 140)).toContain(`tu('${UNIFIED_KEY}')`)
		expect(src.indexOf('await unlockDetachedRecoverPrivateKey(temp.beamioTag', claimAt)).toBeGreaterThan(claimGuard)
		expect(src.indexOf('await fetch(`${beamioApi}/api/businessStartKetRedeemRedeem`', claimAt)).toBeGreaterThan(claimGuard)
	})

	it('agentReferrerRegistryClient: the four registration functions return the unified copy before any wallet is built', () => {
		const src = read('utils/agentReferrerRegistryClient.ts')
		expect(src).toContain("import { tu } from '@/locale/beamioLocale'")
		const guard = "if (shellChatBlockedNow()) return { success: false, error: tu('shell_chat_unavailable_body') }"
		expect(src.split(guard).length - 1).toBe(4)
		for (const name of [
			'registerReferrerUnderIntroducer(',
			'registerAgentOnChain(',
			'registerTempUnderAgent(',
			'registerMerchantUnderAgent(',
		]) {
			const at = src.indexOf(`export async function ${name}`)
			expect(at).toBeGreaterThan(0)
			const g = src.indexOf(guard, at)
			expect(g).toBeGreaterThan(at)
			expect(src.indexOf('walletFromConsumerKey(', at)).toBeGreaterThan(g)
		}
	})
})
