/**
 * The consumer NFC card claim and link feature is removed (project decision 2026-11-13, relay; supersedes the pause of
 * 2026-11-12). An old deep link or QR code for it is recognised only to say so. This module reads no wallet, makes no
 * request and enters no flow: the caller shows a short notice and stops.
 *
 * Recognised: an http(s) URL or a path whose query has the Link App parameter `nftRedeemcode`, or both `tagid` and `uid`
 * (the form of the old Link App link, with any letter case).
 */
export function isRemovedNfcLinkUrl(raw: string): boolean {
	if (typeof raw !== 'string' || !raw.trim()) return false
	try {
		const u = raw.startsWith('http') ? new URL(raw) : new URL(raw, 'https://beamio.ca')
		const keys = new Set<string>()
		u.searchParams.forEach((_value, key) => keys.add(key.toLowerCase()))
		if (keys.has('nftredeemcode')) return true
		return keys.has('tagid') && keys.has('uid')
	} catch {
		return false
	}
}
