/**
 * A link saved with the retired domain (beamio.app) is judged by the current trusted scope and never causes a request to the old domain:
 * every resolver refuses it or says it is removed, and no network, beacon or WebSocket call is made while it is judged. The old domain is in this
 * file only as the negative fixture. SYNTHETIC address only.
 */
import { isMeaningfulConsumerAppDeepLink } from './pendingConsumerDeepLink'
import { classifyBeamioShareUrl, resolveBeamioShareInAppNavigation } from './chatShareLinkPreview'
import { beamioWebHostPrefixOf, isBeamioWebHostname } from './beamioWebHost'
import { isRemovedNfcLinkUrl } from '../services/nfcLinkRemoved'

const CARD = '0x1111111111111111111111111111111111111111'
const OLD = 'beamio.app'

describe('saved links on the retired domain', () => {
	const calls: string[] = []
	const realFetch = (globalThis as { fetch?: unknown }).fetch
	const realBeacon = (navigator as unknown as { sendBeacon?: unknown }).sendBeacon
	const RealXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest
	beforeEach(() => {
		calls.length = 0
		;(globalThis as { fetch?: unknown }).fetch = jest.fn(async (...a: unknown[]) => {
			calls.push(`fetch ${String(a[0])}`)
			throw new Error('no request may be made')
		})
		;(navigator as unknown as { sendBeacon?: unknown }).sendBeacon = jest.fn((u: unknown) => {
			calls.push(`beacon ${String(u)}`)
			return false
		})
		;(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = class {
			open(_m: string, u: string) {
				calls.push(`xhr ${u}`)
			}
			send() {
				calls.push('xhr send')
			}
		}
	})
	/** Lets every pending microtask and timer run: a request started by an asynchronous continuation would be recorded by now. */
	const settleAsync = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve()
		await new Promise((resolve) => setTimeout(resolve, 20))
		for (let i = 0; i < 5; i++) await Promise.resolve()
	}
	afterEach(() => {
		;(globalThis as { fetch?: unknown }).fetch = realFetch
		;(navigator as unknown as { sendBeacon?: unknown }).sendBeacon = realBeacon
		;(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = RealXhr
	})

	it('a share link on the old domain is not a Beamio share link, and it opens nothing', async () => {
		expect(classifyBeamioShareUrl(`https://${OLD}/app/?beamiocard=${CARD}&discover=open`)).toBeNull()
		expect(classifyBeamioShareUrl(`https://www.${OLD}/app/?beamiocard=${CARD}&discover=open`)).toBeNull()
		expect(resolveBeamioShareInAppNavigation(`https://${OLD}/app/?beamiocard=${CARD}&discover=open`)).toBeNull()
		await settleAsync()
		expect(calls).toEqual([])
	})

	it('an app-download link whose target is the old domain is refused', async () => {
		const inner = encodeURIComponent(`https://${OLD}/app/?beamiocard=${CARD}&discover=open`)
		expect(resolveBeamioShareInAppNavigation(`https://beamio.ca/app-download?target=${inner}`)).toBeNull()
		await settleAsync()
		expect(calls).toEqual([])
	})

	it('a custom-scheme deep link on the old domain is not a consumer deep link', async () => {
		expect(isMeaningfulConsumerAppDeepLink(`beamio://${OLD}/app/?beamiocard=${CARD}&discover=open`)).toBe(false)
		await settleAsync()
		expect(calls).toEqual([])
	})

	it('the old host is not a Beamio web host, with or without a scheme', async () => {
		expect(isBeamioWebHostname(OLD)).toBe(false)
		expect(isBeamioWebHostname(`www.${OLD}`)).toBe(false)
		expect(beamioWebHostPrefixOf(`${OLD}/app/?beamiocard=${CARD}`)).toBe(false)
		await settleAsync()
		expect(calls).toEqual([])
	})

	it('an old NFC link is only recognised as removed: it reads nothing and makes no request', async () => {
		expect(isRemovedNfcLinkUrl(`https://${OLD}/app/?nftRedeemcode=AB12CD`)).toBe(true)
		await settleAsync()
		expect(calls).toEqual([])
	})

	it('the current domain still works (the refusals above are about the old host only)', async () => {
		expect(classifyBeamioShareUrl(`https://beamio.ca/app/?beamiocard=${CARD}&discover=open`)).not.toBeNull()
		expect(isBeamioWebHostname('beamio.ca')).toBe(true)
	})
})
