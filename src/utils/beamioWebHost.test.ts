/**
 * the Beamio web host checks are exact equality on host names. No suffix match, no wildcard, no host regular expression.
 * SYNTHETIC values only.
 */
import { beamioWebHostPrefixOf, isBeamioWebHostname, isIpfsOrBeamioFragmentUrl } from './beamioWebHost'

describe('exact Beamio web host checks', () => {
	test('exactly beamio.ca and www.beamio.ca (case-insensitive)', () => {
		expect(isBeamioWebHostname('beamio.ca')).toBe(true)
		expect(isBeamioWebHostname('www.beamio.ca')).toBe(true)
		expect(isBeamioWebHostname('BEAMIO.CA')).toBe(true)
	})

	test('no suffix match, no look-alike, no subdomain', () => {
		expect(isBeamioWebHostname('sub.beamio.ca')).toBe(false)
		expect(isBeamioWebHostname('beamio.ca.evil.test')).toBe(false)
		expect(isBeamioWebHostname('evilbeamio.ca')).toBe(false)
		expect(isBeamioWebHostname('beamio.app')).toBe(false)
	})

	test('scheme-less text: the host is the part before the first separator', () => {
		expect(beamioWebHostPrefixOf('beamio.ca/app/?x=1')).toBe(true)
		expect(beamioWebHostPrefixOf('beamio.ca?beamio=tag')).toBe(true)
		expect(beamioWebHostPrefixOf('beamio.ca.evil.test/app')).toBe(false)
		expect(beamioWebHostPrefixOf('/Vouchers?Amount=1')).toBe(false)
	})

	test('an IPFS fragment URL is recognised by host and path, not by substring', () => {
		expect(isIpfsOrBeamioFragmentUrl('https://beamio.ca/api/fragment?hash=0x11')).toBe(true)
		expect(isIpfsOrBeamioFragmentUrl('https://ipfs.conet.network/api/getFragment?hash=0x11')).toBe(true)
		expect(isIpfsOrBeamioFragmentUrl('https://beamio.ca/api/other?hash=0x11')).toBe(false)
		expect(isIpfsOrBeamioFragmentUrl('https://evil.test/x?u=https://beamio.ca/api/fragment')).toBe(false)
		expect(isIpfsOrBeamioFragmentUrl('https://evil.test/x?u=ipfs.conet.network')).toBe(false)
	})
})
