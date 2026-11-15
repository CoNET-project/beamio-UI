/**
 * @jest-environment node
 *
 * Consumer NFC card bind and claim: removed (project decision 2026-11-13, relay, NFC). Read from the sources, so a
 * re-introduced bind endpoint, call or entry fails here. The normal NFC features (read, top-up, charge, merchant pages) are
 * checked as positive regression: they must still be there and still call their own endpoints.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

const BIND_TOKENS = [
	'api/nfcLinkApp',
	'api/registerNfcCard',
	'api/listLinkedNfcCards',
	'api/nfcCardLinkState',
	'startPhysicalCardBind',
	'cancelPhysicalCardBind',
	'nfcLinkPause',
	'handleNfcLinkAppDeepLinkScan',
	'postNfcCardLinkStateSigned',
	'postListLinkedNfcCards',
	'postNfcLinkApp',
	'walletReadyIntent',
	'nfcSync',
	'cashtreesnfc',
	'linkedNfcCards',
	'showCardManagementModal',
	'privateKeyHexForNfcLinkClaim',
]

const SOURCES_THAT_HAD_BIND = [
	'src/components/Home/Home.tsx',
	'src/services/BeamioCard.ts',
	'src/services/beamio.ts',
	'src/App.tsx',
	'src/components/Home/SearchBarWithResults.tsx',
	'src/pages/Home/WalletReadyScreen.tsx',
	'src/pages/Home/LoadingPage.tsx',
	'src/utils/cashTreesNativeNfc.ts',
	'src/utils/cashTreesIOSBridge.ts',
]

describe('consumer NFC bind and claim: removed', () => {
	it.each(SOURCES_THAT_HAD_BIND)('%s has no bind endpoint, call or entry', (rel) => {
		const text = read(rel)
		for (const tok of BIND_TOKENS) expect({ rel, tok, hit: text.includes(tok) }).toEqual({ rel, tok, hit: false })
	})

	it('the deep link and QR handlers show the notice and stop: no wallet, no profile, no navigation into a flow', () => {
		const app = read('src/App.tsx')
		const search = read('src/components/Home/SearchBarWithResults.tsx')
		for (const [label, text, anchor] of [
			['App deep link', app, 'if (isRemovedNfcLinkUrl(url)) {'],
			['App QR scan', app, 'if (isRemovedNfcLinkUrl(scanData)) {'],
			['search bar', search, 'if (isRemovedNfcLinkUrl(url.href)) {'],
		] as const) {
			const i = text.indexOf(anchor)
			expect({ label, found: i > 0 }).toEqual({ label, found: true })
			const block = text.slice(i, text.indexOf('return', i) + 'return'.length + 4)
			expect({ label, block: /Wallet|profile|privateKey|CoNET_Data|sessionStorage|fetch\(|navigate\(/.test(block) }).toEqual({
				label,
				block: false,
			})
			expect({ label, notice: block.includes("tu('nfc_link_removed_message')") }).toEqual({ label, notice: true })
		}
	})

	it('the old link module is replaced by the detector only', () => {
		expect(() => read('src/services/nfcLinkPause.ts')).toThrow()
		expect(read('src/services/nfcLinkRemoved.ts')).toMatch(/export function isRemovedNfcLinkUrl/)
	})

	it('the card-state signing and the linked-card list are gone from the wallet services', () => {
		const card = read('src/services/BeamioCard.ts')
		expect(card).not.toMatch(/export async function (postNfcCardLinkStateSigned|postListLinkedNfcCards|postNfcLinkApp)\b/)
		expect(card).not.toMatch(/buildNfcCardLinkStateSignMessage|NFC_CARD_LINK_STATE_SCOPE/)
	})
})

describe('normal NFC features: unchanged (positive regression)', () => {
	it('the NFC balance read keeps its response types and its endpoint call', () => {
		const card = read('src/services/BeamioCard.ts')
		expect(card).toMatch(/export type UidAssetsNfcResponse = /)
		expect(card).toMatch(/export async function postGetUidAssetsForNfcScan\(/)
		expect(card).toMatch(/fetch\(`\$\{beamioApi\}\/api\/getUIDAssets`/)
	})

	it('the NFC charge session and top-up keep their endpoints', () => {
		expect(read('src/utils/usdcChargeSessionApi.ts')).toMatch(/\/api\/nfcUsdcChargeSession\?/)
		expect(read('src/utils/usdcChargeSessionApi.ts')).toMatch(/\/api\/nfcUsdcChargeTopupAuth`/)
		expect(read('src/utils/discoverUsdcTopupSession.ts')).toMatch(/\/api\/nfcUsdcTopup`/)
	})

	it('the NFC read hook and its merchant-side wiring stay', () => {
		expect(read('src/hooks/useNfcRead.ts')).toMatch(/useNfcRead/)
		expect(read('src/pages/History/MyWalletDashboardNew.tsx')).toMatch(/readUid=\{readNfcUid\}/)
	})

	it('the wallet-ready screen keeps the cashier top-up and gift voucher steps', () => {
		const wr = read('src/pages/Home/WalletReadyScreen.tsx')
		expect(wr).toMatch(/onCashierTopUp/)
		expect(wr).toMatch(/onRedeemGiftVoucher/)
		expect(wr).toMatch(/onFinishLater/)
	})

	it('the payment URL scan path is untouched', () => {
		const app = read('src/App.tsx')
		expect(app).toMatch(/isPaymentUrl\(scanData\)/)
		expect(app).toMatch(/setScanIntent\('voucherPay'\)/)
	})
})
