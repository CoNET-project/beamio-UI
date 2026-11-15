/**
 * every request on the first-screen / boot path has a bound, and a failed call keeps its existing failure path.
 * Source checks; the behaviour is exercised by the fault-injection receipt and the unit tests next to each module.
 */
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')

describe('start path: every boot request is bounded', () => {
	const beamio = read('src/services/beamio.ts')
	const app = read('src/App.tsx')
	const chat = read('src/services/chat.ts')
	const excluded = read('src/utils/apiExcludedUserCards.ts')
	const aa = read('src/utils/ensureConetAa.ts')

	test('the account save (addUser) is bounded and always releases its timer', () => {
		const start = beamio.indexOf('const postBeamioFrom = async')
		const end = beamio.indexOf('export const postBeamio = async', start)
		const seg = beamio.slice(start, end)
		expect(seg).toMatch(/const timeout = abortAfter\(BOOT_REQUEST_TIMEOUT_MS\)/)
		expect(seg).toMatch(/signal: timeout\.signal/)
		expect(seg).toMatch(/finally \{\s*timeout\.done\(\)/)
	})

	test('the balance read and the BUnit eligibility read are bounded', () => {
		const bal = beamio.slice(beamio.indexOf('const fetchBalanceFromApi'), beamio.indexOf('const fetchBalanceFromApi') + 1000)
		expect(bal).toMatch(/signal: timeout\.signal/)
		expect(bal).toMatch(/finally \{\s*timeout\.done\(\)/)
		const elig = beamio.slice(beamio.indexOf('export const checkBUnitClaimEligibility'), beamio.indexOf('export const checkBUnitClaimEligibility') + 1200)
		expect(elig).toMatch(/\{ signal: timeout\.signal \}/)
		expect(elig).toMatch(/finally \{\s*timeout\.done\(\)/)
	})

	test('the excluded-cards read (shared, at boot) is bounded and clears its in-flight entry', () => {
		expect(excluded).toMatch(/const timeout = abortAfter\(BOOT_REQUEST_TIMEOUT_MS\)/)
		expect(excluded).toMatch(/signal: timeout\.signal/)
		expect(excluded).toMatch(/finally \{\s*timeout\.done\(\)\s*loadInFlight = null/)
	})

	test('the chat route registration POST (chat start) is bounded', () => {
		const start = chat.indexOf('const postRegiestChatRoute = async')
		const seg = chat.slice(start, start + 700)
		expect(seg).toMatch(/signal: timeout\.signal/)
		expect(seg).toMatch(/finally \{\s*timeout\.done\(\)/)
	})

	test('the AA ensure (API and CoNET RPC steps) is bounded', () => {
		expect(aa).toMatch(/ensureAAForEOAOnConet\?eoa=\$\{encodeURIComponent\(eoa\)\}`, \{ signal: timeout\.signal \}/)
		expect(aa).toMatch(/withBootTimeout\(resolveBeamioAaOnConet\(conetProvider, norm\)\.catch\(\(\) => null\), BOOT_REQUEST_TIMEOUT_MS, null\)/)
		expect(aa).toMatch(/withBootTimeout\(conetProvider\.getCode\(created\)\.catch\(\(\) => '0x'\), BOOT_REQUEST_TIMEOUT_MS, '0x'\)/)
	})

	test('the beamioTag worker fetches (card metadata, excluded list, search) are bounded and release their timers', () => {
		const card = read('src/workers/beamioTag/merchantCardServerDb.ts')
		const tag = read('src/workers/beamioTag/tagServerDb.ts')
		const meta = card.slice(card.indexOf('async function fetchCardMetadataFromApi'), card.indexOf('async function fetchCardMetadataFromApi') + 1500)
		expect(meta).toMatch(/signal: timeout\.signal/)
		expect(meta).toMatch(/finally \{\s*timeout\.done\(\)/)
		const uri = card.slice(card.indexOf('async function fetchCardMetadataFromUri'), card.indexOf('async function fetchCardMetadataFromUri') + 1400)
		expect(uri.match(/signal: timeout\.signal/g)?.length).toBe(3)
		expect(card).toMatch(/signal: timeout\.signal,?\s*\}\)\s*\n\s*if \(!res\.ok\) throw|excludedInFlight = \(async \(\) => \{[\s\S]{0,400}signal: timeout\.signal/)
		expect(card).toMatch(/\} finally \{\s*timeout\.done\(\)\s*excludedInFlight = null/)
		const search = tag.slice(tag.indexOf('async fetchSearchUsers'), tag.indexOf('async fetchSearchUsers') + 700)
		expect(search).toMatch(/signal: timeout\.signal/)
		expect(search).toMatch(/finally \{\s*timeout\.done\(\)/)
	})

	test('the B-Unit display read is bounded, falls back to the RPC, and a fault is unavailable, never zero', () => {
		const card = read('src/services/BeamioCard.ts')
		const start = card.indexOf('export const getBUnitBalanceOnConet')
		const seg = card.slice(start, start + 1100)
		expect(seg).toMatch(/readBUnitBalanceWithFallback\(\{/)
		expect(seg).toMatch(/readApi: async \(signal\) => \{/)
		expect(seg).toMatch(/\{ signal \}\)/)
		expect(seg).toMatch(/readRpc: \(\) => readBUnitBalanceFromRpcState\(account\)/)
		// The payment read keeps its zero-on-failure contract: a failure never relaxes a payment check.
		const pay = card.slice(card.indexOf('export const getBUnitBalanceFromConetRpc'), card.indexOf('export const getBUnitBalanceFromConetRpc') + 400)
		expect(pay).toMatch(/: \{ total: 0, free: 0, paid: 0 \}/)
	})

	test('the App init side calls are bounded and fall back (provision and locale sync)', () => {
		expect(app).toMatch(/withBootTimeout\(bootstrapProfileLocaleCurrencyIfUnset\(bo, pk\), BOOT_LOCALE_SYNC_TIMEOUT_MS, bo\)/)
		expect(app).toMatch(/withBootTimeout\(ensureEphemeralWalletForCouponClaim\(\), BOOT_PROVISION_TIMEOUT_MS, null\)/)
	})
})
