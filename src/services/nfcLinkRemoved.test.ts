/**
 * @jest-environment node
 *
 * The old NFC Link App deep link and QR (removed 2026-11-13): recognised only to show the notice. The module reads no
 * wallet and imports nothing, so it cannot reach a key.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { isRemovedNfcLinkUrl } from './nfcLinkRemoved'

describe('isRemovedNfcLinkUrl: old Link App deep links and QR codes', () => {
	it('recognises the old link form, in any letter case and as a path', () => {
		expect(isRemovedNfcLinkUrl('https://beamio.ca/app/?nftRedeemcode=AB12CD&tagid=0011223344556677&uid=04aabbccddeeff&counter=7')).toBe(true)
		expect(isRemovedNfcLinkUrl('https://beamio.ca/app/?NFTREDEEMCODE=AB12CD')).toBe(true)
		expect(isRemovedNfcLinkUrl('/app/?tagId=0011223344556677&UID=04AABBCCDDEEFF')).toBe(true)
	})

	it('recognises the old link when the tag and uid are both present, even without the code', () => {
		expect(isRemovedNfcLinkUrl('https://beamio.ca/app/?tagid=0011223344556677&uid=04aabbccddeeff')).toBe(true)
	})

	it('does not treat ordinary links and payment URLs as the removed link', () => {
		expect(isRemovedNfcLinkUrl('https://beamio.ca/app/?beamio=alice')).toBe(false)
		expect(isRemovedNfcLinkUrl('https://beamio.ca/app/?redeemcode=xyz')).toBe(false)
		expect(isRemovedNfcLinkUrl('https://beamio.ca/app/?tagid=0011223344556677')).toBe(false)
		expect(isRemovedNfcLinkUrl('0x' + '11'.repeat(20))).toBe(false)
		expect(isRemovedNfcLinkUrl('not a url at all')).toBe(false)
		expect(isRemovedNfcLinkUrl('')).toBe(false)
	})

	it('never throws on malformed input', () => {
		expect(() => isRemovedNfcLinkUrl('https://[::1')).not.toThrow()
		expect(isRemovedNfcLinkUrl('https://[::1')).toBe(false)
	})

	it('imports nothing, so it cannot read a wallet or reach the network', () => {
		const src = readFileSync(join(__dirname, 'nfcLinkRemoved.ts'), 'utf8')
		expect(src).not.toMatch(/^import\s/m)
		expect(src).not.toMatch(/fetch\(|ethers|localStorage|sessionStorage|CoNET_Data|profiles/)
	})
})
