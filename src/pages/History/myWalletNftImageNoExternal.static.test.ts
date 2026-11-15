/**
 * the uploaded NFT image is viewed in the page. It is never opened externally: no openExternalUrl, no native openURL and
 * no openInAppBrowser for the image link (the link carries a 64-hex fragment hash in its query, which the shells reject). Source guard.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'MyWalletDashboardNew.tsx'), 'utf8')

describe('the NFT image link is not opened externally', () => {
	it('no call passes the image link to an external open', () => {
		expect(src).not.toContain('openExternalUrl(newNftImageUrl)')
		expect(src).not.toMatch(/openURL\(\s*newNftImageUrl/)
		expect(src).not.toMatch(/openInAppBrowser\(\s*newNftImageUrl/)
	})

	it('the link button opens the in-page viewer, which shows the image with an IpfsImg', () => {
		expect(src).toContain('onClick={() => setNftImageViewOpen(true)}')
		expect(src).toContain('{newNftImageUrl && nftImageViewOpen ? (')
		const at = src.indexOf('{newNftImageUrl && nftImageViewOpen ? (')
		expect(src.slice(at, at + 900)).toContain('<IpfsImg src={newNftImageUrl} alt="NFT"')
	})
})
