/**
 * @jest-environment node
 *
 * Option A: wallet, validator, BountyBoard, brand and sheet entries are disabled in a shell without
 * the chat capability. The entries read the hook or the shared capability check before a key is read. These are static guards:
 * the sources are read, so a removed guard fails this test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

const UNIFIED_KEYS = ['shell_chat_unavailable_title', 'shell_chat_unavailable_body']

describe('the entries read the hook or the shared capability check', () => {
	it('ValidatorDepositRedeemAdminSheet: create and cancel refuse before the key is read', () => {
		const src = read('components/BountyBoard/ValidatorDepositRedeemAdminSheet.tsx')
		const resolver = "const armor = resolveSigningPrivateKeyArmor(profiles?.[0] ?? CoNET_Data?.profiles?.[0])"
		const first = src.indexOf(resolver)
		const second = src.indexOf(resolver, first + 1)
		expect(first).toBeGreaterThan(0)
		expect(second).toBeGreaterThan(first)
		// create (first occurrence): guard before the key read, unified copy in the form error
		const createGuard = src.lastIndexOf('if (shellChatBlockedNow()) {', first)
		expect(createGuard).toBeGreaterThan(src.indexOf('const handleCreate = useCallback(', 0))
		expect(src.slice(createGuard, first)).toContain("setFormError(shellChatBlockedText())")
		// cancel (second occurrence): guard before the key read, unified copy in the toast
		const cancelGuard = src.lastIndexOf('if (shellChatBlockedNow()) {', second)
		expect(cancelGuard).toBeGreaterThan(first)
		expect(src.slice(cancelGuard, second)).toContain("Toast.show({ content: shellChatBlockedText(), position: 'top' })")
	})

	it('ValidatorDepositRedeemClaimSheet: claim refuses before the key is read', () => {
		const src = read('components/BountyBoard/ValidatorDepositRedeemClaimSheet.tsx')
		const at = src.indexOf('const handleClaim = useCallback(async () => {')
		const guard = src.indexOf('if (shellChatBlockedNow()) {', at)
		const key = src.indexOf('resolveSigningPrivateKeyArmor(profiles?.[0])', at)
		expect(at).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(at)
		expect(src.slice(guard, guard + 120)).toContain("setFormError(shellChatBlockedText())")
		expect(key).toBeGreaterThan(guard)
	})

	it('BusinessStartKetRedeemAdminPage: create refuses before the key is read', () => {
		const src = read('pages/Wallet/BusinessStartKetRedeemAdminPage.tsx')
		const at = src.indexOf('const handleCreate = useCallback(async () => {')
		const guard = src.indexOf('if (shellChatBlockedNow()) {', at)
		const key = src.indexOf('resolveSigningPrivateKeyArmor(profiles?.[0])', at)
		expect(at).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(at)
		expect(src.slice(guard, guard + 120)).toContain("setFormError(shellChatBlockedText())")
		expect(key).toBeGreaterThan(guard)
	})

	it('CoNetMiningDetailPage: the inline redeem refuses before the key is read', () => {
		const src = read('pages/BountyBoard/CoNetMiningDetailPage.tsx')
		const at = src.indexOf('const handleInlineRedeem = useCallback(async () => {')
		const guard = src.indexOf('if (shellChatBlockedNow()) {', at)
		const key = src.indexOf('resolveSigningPrivateKeyArmor(profiles?.[0])', at)
		expect(at).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(at)
		expect(src.slice(guard, guard + 160)).toContain("setInlineError(shellChatBlockedText())")
		expect(key).toBeGreaterThan(guard)
	})

	it('AaMultisigPage: the signing-key gates show the unified copy in a blocked shell', () => {
		const src = read('pages/Wallet/AaMultisigPage.tsx')
		expect(src).toContain("import { shellChatBlockedNow } from '@/services/shellChatCapability'")
		expect(src).toContain("Toast.show({ content: shellChatBlockedNow() ? shellChatBlockedText() : 'Wallet signing key unavailable.' })")
		expect(src).toContain("setTransferCreateError(shellChatBlockedNow() ? shellChatBlockedText() : 'Wallet signing key unavailable.')")
		expect(src).toContain("fail(shellChatBlockedNow() ? shellChatBlockedText() : 'Wallet signing key unavailable.')")
	})

	it('Genesis node, L1 and L0 pages: the armor follows the shell state, so the action buttons stay disabled', () => {
		for (const rel of [
			'pages/BountyBoard/GenesisNodeReferralPage.tsx',
			'pages/BountyBoard/GenesisL1EvangelistManagePage.tsx',
			'pages/BountyBoard/GenesisL0RedeemManagePage.tsx',
		]) {
			const src = read(rel)
			expect(src).toContain("import { useIdentityEntryDisabled } from '@/hooks/useIdentityEntryDisabled'")
			expect(src).toContain('const identityEntryDisabled = useIdentityEntryDisabled()')
			expect(src).toMatch(
				/const armor = useMemo\(\s*\(\) => \(identityEntryDisabled \? '' : resolveSigningPrivateKeyArmor\(profiles\?\.\[0\] \?\? CoNET_Data\?\.profiles\?\.\[0\]\)\),\s*\[identityEntryDisabled, profiles\],/,
			)
		}
	})

	it('WalletOverview: the referral claim entry is disabled in a blocked shell', () => {
		const src = read('pages/Wallet/WalletOverview.tsx')
		expect(src).toContain('const identityEntryDisabled = useIdentityEntryDisabled()')
		expect(src).toContain('onClick={() => setShowReferralClaimSheet(true)} disabled={identityEntryDisabled}')
	})

	it('ReferralRegistryDashboardPage: the admin openers are disabled and the privileged section is the unified notice', () => {
		const src = read('pages/Wallet/ReferralRegistryDashboardPage.tsx')
		expect(src).toContain("import ShellChatUnavailableNotice from '@/components/ShellChatUnavailableNotice'")
		expect(src).toContain('const identityEntryDisabled = useIdentityEntryDisabled()')
		for (const opener of [
			'onClick={() => setGlobalSettingsOpen(true)} disabled={identityEntryDisabled}',
			'onClick={() => setAdminPackageOpen(true)} disabled={identityEntryDisabled}',
			"onClick={() => setRedeemPanelKind('l0')} disabled={identityEntryDisabled}",
			"onClick={() => setRedeemPanelKind('l1')} disabled={identityEntryDisabled}",
		]) {
			expect(src).toContain(opener)
		}
		expect(src).toContain('snapshot && isPrivileged && identityEntryDisabled ? (\n\t\t\t\t\t\t\t<ShellChatUnavailableNotice />')
	})

	it('HomeLanguageSelector is not an identity entry: with no key it saves the language locally and signs nothing', () => {
		const src = read('components/Home/HomeLanguageSelector.tsx')
		expect(src).toContain('if (beamio && pk) {')
		expect(src).toContain('const localBo = await persistBeamioLanguageLocally(beamio, next)')
	})

	it('only the two unified keys are used for the blocked copy ', () => {
		const changed = [
			'components/BountyBoard/ValidatorDepositRedeemAdminSheet.tsx',
			'components/BountyBoard/ValidatorDepositRedeemClaimSheet.tsx',
			'pages/Wallet/BusinessStartKetRedeemAdminPage.tsx',
			'pages/BountyBoard/CoNetMiningDetailPage.tsx',
			'pages/Wallet/AaMultisigPage.tsx',
			'pages/Wallet/WalletOverview.tsx',
			'pages/Wallet/ReferralRegistryDashboardPage.tsx',
			'pages/BountyBoard/GenesisNodeReferralPage.tsx',
			'pages/BountyBoard/GenesisL1EvangelistManagePage.tsx',
			'pages/BountyBoard/GenesisL0RedeemManagePage.tsx',
		]
		for (const rel of changed) {
			const used = [...read(rel).matchAll(/shell_chat_unavailable_[a-z]+/g)].map((m) => m[0])
			for (const k of used) expect(UNIFIED_KEYS).toContain(k)
		}
	})
})
