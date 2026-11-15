/**
 * the active allowlists accept exactly beamio.ca and www.beamio.ca. No wildcard, no old domain in the candidate.
 * SYNTHETIC addresses only.
 */
import { isMeaningfulConsumerAppDeepLink } from './pendingConsumerDeepLink'
import { classifyBeamioShareUrl, resolveBeamioShareInAppNavigation } from './chatShareLinkPreview'

const CARD = '0x1111111111111111111111111111111111111111'

describe('active host allowlist (exact names only)', () => {
	test('a custom-scheme deep link on beamio.ca is accepted', () => {
		expect(isMeaningfulConsumerAppDeepLink(`beamio://beamio.ca/app/?beamiocard=${CARD}&discover=open`)).toBe(true)
	})

	test('a custom-scheme deep link on www.beamio.ca is accepted', () => {
		expect(isMeaningfulConsumerAppDeepLink(`beamio://www.beamio.ca/app/?beamiocard=${CARD}&discover=open`)).toBe(true)
	})

	test('no wildcard: a subdomain of beamio.ca is refused', () => {
		expect(isMeaningfulConsumerAppDeepLink(`beamio://sub.beamio.ca/app/?beamiocard=${CARD}&discover=open`)).toBe(false)
	})

	test('the old domain is not in the candidate allowlist (custom scheme)', () => {
		expect(isMeaningfulConsumerAppDeepLink(`beamio://beamio.app/app/?beamiocard=${CARD}&discover=open`)).toBe(false)
	})

	test('share links: beamio.ca and www.beamio.ca are recognised', () => {
		expect(classifyBeamioShareUrl(`https://beamio.ca/app/?beamiocard=${CARD}&discover=open`)).not.toBeNull()
		expect(classifyBeamioShareUrl(`https://www.beamio.ca/app/?beamiocard=${CARD}&discover=open`)).not.toBeNull()
	})

	test('share links: a wildcard subdomain and the old domain are refused', () => {
		expect(classifyBeamioShareUrl(`https://evil.beamio.ca/app/?beamiocard=${CARD}&discover=open`)).toBeNull()
		expect(classifyBeamioShareUrl(`https://beamio.app/app/?beamiocard=${CARD}&discover=open`)).toBeNull()
	})

	test('app-download target origin: only https://beamio.ca', () => {
		const inner = encodeURIComponent(`https://beamio.ca/app/?beamiocard=${CARD}&discover=open`)
		expect(resolveBeamioShareInAppNavigation(`https://beamio.ca/app-download?target=${inner}`)).not.toBeNull()
		const oldInner = encodeURIComponent(`https://beamio.app/app/?beamiocard=${CARD}&discover=open`)
		expect(resolveBeamioShareInAppNavigation(`https://beamio.ca/app-download?target=${oldInner}`)).toBeNull()
	})
})
