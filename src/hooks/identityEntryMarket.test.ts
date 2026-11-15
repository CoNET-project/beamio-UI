/**
 * @jest-environment node
 *
 * Option A: identity entries of Market, merchant gifts and the pay code are disabled in a shell
 * without the chat capability. The entries read the hook or the shared capability check before any key or stored profile is
 * read. These are static guards: the sources are read, so a removed guard fails this test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

const UNIFIED_KEYS = ['shell_chat_unavailable_title', 'shell_chat_unavailable_body']

describe('the entries read the hook or the shared capability check', () => {
	it('ShowPayCodeSheet: the pay code is replaced by the unified notice and no QR or unlock copy is drawn', () => {
		const src = read('components/Home/ShowPayCodeSheet.tsx')
		expect(src).toContain("import { useIdentityEntryDisabled } from '@/hooks/useIdentityEntryDisabled'")
		expect(src).toContain('const identityEntryDisabled = useIdentityEntryDisabled()')
		expect(src).toContain('{identityEntryDisabled ? <ShellChatUnavailableNotice /> : null}')
		expect(src).toContain('{!identityEntryDisabled && !payRelayQRLoading && !payRelayQRPayload ? (')
	})

	it('MerchantAssetGiftSheet: handleSubmit refuses before any key is read', () => {
		const src = read('components/Home/MerchantAssetGiftSheet.tsx')
		const at = src.indexOf('const handleSubmit = async () => {')
		const guard = src.indexOf('if (shellChatBlockedNow()) {', at)
		const key = src.indexOf('resolveSigningPrivateKeyArmor(profile)', at)
		expect(at).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(at)
		expect(src.slice(guard, guard + 120)).toContain("setSubmitError(tu('shell_chat_unavailable_body'))")
		expect(key).toBeGreaterThan(guard)
	})

	it('MerchantGiftClaimSheet: handleClaim refuses before any key is read', () => {
		const src = read('components/Home/MerchantGiftClaimSheet.tsx')
		const at = src.indexOf('const handleClaim = async () => {')
		const guard = src.indexOf('if (shellChatBlockedNow()) {', at)
		const key = src.indexOf('resolveSigningPrivateKeyArmor(profile)', at)
		expect(at).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(at)
		expect(src.slice(guard, guard + 120)).toContain("setPanelError(tu('shell_chat_unavailable_body'))")
		expect(key).toBeGreaterThan(guard)
	})

	it('useCouponUserLike: submitLike refuses before the stored profile is read', () => {
		const src = read('hooks/useCouponUserLike.ts')
		const at = src.indexOf('const submitLike = useCallback(async () => {')
		const guard = src.indexOf('if (shellChatBlockedNow()) {', at)
		const stored = src.indexOf('await checkStorage({ probe: true })', at)
		expect(at).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(at)
		expect(src.slice(guard, guard + 160)).toContain("Toast.show({ content: tu('shell_chat_unavailable_body'), position: 'top' })")
		expect(stored).toBeGreaterThan(guard)
	})

	it('MerchantCardTopUpFlow: the membership claim, the membership pay and the legs pay refuse in a blocked shell', () => {
		const src = read('pages/Vouchers/MerchantCardTopUpFlow.tsx')
		// claimZeroFeeMembership: the no-key branch shows the unified copy
		expect(src).toMatch(/if \(!key \|\| !wallet\) \{[\s\S]{0,200}setPayError\(shellChatBlockedNow\(\) \? tu\('shell_chat_unavailable_body'\) : 'Sign in to claim membership\.'\)/)
		// goPay (membership branch): the guard comes before the key is read
		const goPay = src.indexOf('const goPay = () => {')
		const goGuard = src.indexOf('if (shellChatBlockedNow()) {', goPay)
		const goKey = src.indexOf('const key = resolveSigningPrivateKeyArmor(profile)', goPay)
		expect(goPay).toBeGreaterThan(0)
		expect(goGuard).toBeGreaterThan(goPay)
		expect(goKey).toBeGreaterThan(goGuard)
		// redeemLegsThenBuy: the guard comes before the busy flag and the key
		const redeem = src.indexOf('const redeemLegsThenBuy = async () => {')
		const redeemGuard = src.indexOf('if (shellChatBlockedNow()) {', redeem)
		const redeemBusy = src.indexOf('setPayBusy(true)', redeem)
		const redeemKey = src.indexOf('resolveSigningPrivateKeyArmor(profile)', redeem)
		expect(redeem).toBeGreaterThan(0)
		expect(redeemGuard).toBeGreaterThan(redeem)
		expect(redeemBusy).toBeGreaterThan(redeemGuard)
		expect(redeemKey).toBeGreaterThan(redeemGuard)
	})

	it('DiscoverMerchantGiftSheet: handlePurchase refuses before the key is read', () => {
		const src = read('components/Home/DiscoverMerchantGiftSheet.tsx')
		const at = src.indexOf('const handlePurchase = async () => {')
		const guard = src.indexOf('if (shellChatBlockedNow()) {', at)
		const key = src.indexOf('const pk = resolveSigningPrivateKeyArmor(profile)', at)
		expect(at).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(at)
		expect(src.slice(guard, guard + 120)).toContain("setPanelError(tu('shell_chat_unavailable_body'))")
		expect(key).toBeGreaterThan(guard)
	})

	it('Market: the genesis seat lock, the merchant like, the top-up, the EOA top-up and the coupon claim refuse in a blocked shell', () => {
		const src = read('pages/Vouchers/Market.tsx')

		// DiscoverMerchantDetailFullScreen reads the hook once; the like button is disabled by it
		expect(src).toContain('const identityEntryDisabled = useIdentityEntryDisabled()')
		expect(src).toContain('disabled={likeLoading || Boolean(userLiked) || identityEntryDisabled}')

		const seat = src.indexOf('const lockConetGenesisSeat = useCallback(')
		const seatGuard = src.indexOf('if (shellChatBlockedNow()) {', seat)
		const seatKey = src.indexOf('const privateKeyArmor = resolveSigningPrivateKeyArmor(profile)', seat)
		expect(seat).toBeGreaterThan(0)
		expect(seatGuard).toBeGreaterThan(seat)
		expect(seatKey).toBeGreaterThan(seatGuard)

		const like = src.indexOf('const submitMerchantUserLike = useCallback(async () => {')
		const likeGuard = src.indexOf('if (shellChatBlockedNow()) {', like)
		const likeStored = src.indexOf('await checkStorage({ probe: true })', like)
		expect(like).toBeGreaterThan(0)
		expect(likeGuard).toBeGreaterThan(like)
		expect(src.slice(likeGuard, likeGuard + 120)).toContain("setLikeError(tu('shell_chat_unavailable_body'))")
		expect(likeStored).toBeGreaterThan(likeGuard)

		const topup = src.indexOf('const handleUsdcTopupContinue = useCallback(async () => {')
		const topupGuard = src.indexOf('if (shellChatBlockedNow()) {', topup)
		const topupKey = src.indexOf('const privateKeyArmor = resolveSigningPrivateKeyArmor(profile)', topup)
		expect(topup).toBeGreaterThan(0)
		expect(topupGuard).toBeGreaterThan(topup)
		expect(topupKey).toBeGreaterThan(topupGuard)

		const eoa = src.indexOf('const runDiscoverEoaTopupNow = useCallback(async () => {')
		const eoaGuard = src.indexOf('if (shellChatBlockedNow()) {', eoa)
		const eoaKey = src.indexOf('resolveSigningPrivateKeyArmor(profile)', eoa)
		expect(eoa).toBeGreaterThan(0)
		expect(eoaGuard).toBeGreaterThan(eoa)
		expect(eoaKey).toBeGreaterThan(eoaGuard)

		const claim = src.indexOf('const handleDiscoverCouponClaim = useCallback(')
		const claimGuard = src.indexOf('if (shellChatBlockedNow()) {', claim)
		const claimStored = src.indexOf('await checkStorage({ probe: true })', claim)
		expect(claim).toBeGreaterThan(0)
		expect(claimGuard).toBeGreaterThan(claim)
		expect(src.slice(claimGuard, claimGuard + 160)).toContain(
			"setCouponClaimErrorById((s) => ({ ...s, [row.id]: tu('shell_chat_unavailable_body') }))",
		)
		expect(claimStored).toBeGreaterThan(claimGuard)
	})

	it('only the two unified keys are used for the blocked copy, and no key is added to the locale files', () => {
		const changed = [
			'components/Home/ShowPayCodeSheet.tsx',
			'components/Home/MerchantAssetGiftSheet.tsx',
			'components/Home/MerchantGiftClaimSheet.tsx',
			'components/Home/DiscoverMerchantGiftSheet.tsx',
			'hooks/useCouponUserLike.ts',
			'pages/Vouchers/MerchantCardTopUpFlow.tsx',
			'pages/Vouchers/Market.tsx',
		]
		for (const rel of changed) {
			const used = [...read(rel).matchAll(/shell_chat_unavailable_[a-z]+/g)].map((m) => m[0])
			for (const k of used) {
				expect(UNIFIED_KEYS).toContain(k)
			}
		}
		for (const loc of ['locale/en.json', 'locale/zh-CN.json']) {
			const src = read(loc)
			for (const k of UNIFIED_KEYS) expect(src).toContain(`"${k}"`)
			expect(src.match(/"shell_chat_unavailable_[a-z]+"/g)?.length).toBe(UNIFIED_KEYS.length)
		}
	})
})
