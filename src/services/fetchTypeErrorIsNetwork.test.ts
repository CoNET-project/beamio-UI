/**
 * @jest-environment node
 */
// a browser fetch failure (a TypeError "Failed to fetch" and its Safari/Firefox/Node forms) is network_error: the send is held
// (route_unconfirmed, retried automatically, Retry button). A TypeError that is a fault in our code stays internal_error. SYNTHETIC values.
import { readRecipientRecord, isProgrammingError, isFetchNetworkTypeError, fetchTypeErrorWording } from './recipientRecord'
import { refreshRecipient, resolveTrustedRoute, resolveRecipientPublicArmored, type FetchRecipientRoute } from '../utils/recipientPublicKey'

const CONTACT = '0x' + 'ab12'.repeat(10)
const decode = (s: string) => s
// Chrome 156 and Node 22 wordings were MEASURED; Safari/WKWebView and Firefox wordings are documented ones, not measured here
const FETCH_MESSAGES = ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'fetch failed', 'The network connection was lost.', 'The Internet connection appears to be offline.']
const typeError = (m: string) => new TypeError(m)

describe('the classification of a fetch TypeError', () => {
	it.each(FETCH_MESSAGES)('%s is a network failure, not a programming error', (m) => {
		expect(isFetchNetworkTypeError(typeError(m))).toBe(true)
		expect(isProgrammingError(typeError(m))).toBe(false)
	})
	it('the wording key is reported (a fixed vocabulary), never the text', () => {
		expect(fetchTypeErrorWording(typeError('Failed to fetch'))).toBe('failed_to_fetch')
		expect(fetchTypeErrorWording(typeError('Load failed'))).toBe('load_failed')
		expect(fetchTypeErrorWording(typeError('fetch failed'))).toBe('fetch_failed')
		expect(fetchTypeErrorWording(typeError('NetworkError when attempting to fetch resource.'))).toBe('networkerror')
	})
	it('the wording must be the whole message: a code fault that merely mentions it stays a programming error', () => {
		for (const m of ["Cannot read properties of undefined (reading 'load failed')", 'x.fetch failed is not a function', 'Failed to fetch dynamically imported module', 'Load failed: bad argument']) {
			expect(isProgrammingError(typeError(m))).toBe(true)
			expect(isFetchNetworkTypeError(typeError(m))).toBe(false)
		}
	})
	it('genuine programming errors, measured in Chrome 156, stay programming errors', () => {
		for (const m of ["Cannot read properties of undefined (reading 'x')", 'o.f is not a function', 'Failed to construct \'URL\': Invalid URL', 'undefined is not iterable']) expect(isProgrammingError(typeError(m))).toBe(true)
	})
	it('a TypeError that is a fault in our code, and other fault classes, stay programming errors', () => {
		expect(isProgrammingError(typeError("Cannot read properties of undefined (reading 'x')"))).toBe(true)
		expect(isProgrammingError(typeError('x is not a function'))).toBe(true)
		expect(isProgrammingError(new ReferenceError('y'))).toBe(true)
		expect(isFetchNetworkTypeError(new Error('Failed to fetch'))).toBe(false) // only a TypeError is matched; a plain Error was network_error already
	})
	it('the reader returns network_error for a fetch TypeError and keeps internal_error for a code fault', async () => {
		for (const m of FETCH_MESSAGES) {
			const r = await readRecipientRecord(() => Promise.reject(typeError(m)), decode)
			expect(r).toMatchObject({ status: 'network_error', reason: expect.stringMatching(/^fetch_typeerror:[a-z_]+$/) })
		}
		expect(await readRecipientRecord(() => Promise.reject(typeError('x is not a function')), decode)).toEqual({ status: 'internal_error', reason: 'TypeError' })
	})
})

describe('the send path of the page (recipientPublicKey) follows it', () => {
	const failing = (m: string): FetchRecipientRoute => async () => {
		throw typeError(m)
	}
	it('a fetch TypeError thrown by the fetcher: refresh and resolve say network_error (not recipient_key_unavailable)', async () => {
		expect(await refreshRecipient({ address: CONTACT, chatData: {} }, failing('Failed to fetch'))).toEqual({ ok: false, code: 'network_error' })
		expect(await resolveRecipientPublicArmored({ address: CONTACT, chatData: {} }, failing('Load failed'))).toEqual({ ok: false, code: 'network_error' })
	})
	it('the trusted route is held as route_unconfirmed (retried automatically; the Retry button), not "key unavailable"', async () => {
		const r = await resolveTrustedRoute({ address: CONTACT, chatData: { verifiedFingerprint: 'openpgp:' + 'a'.repeat(40) } }, failing('Failed to fetch'))
		expect(r).toMatchObject({ ok: false, code: 'route_unconfirmed' })
	})
	it('a TypeError that is a fault in our code is still "key unavailable"', async () => {
		expect(await refreshRecipient({ address: CONTACT, chatData: {} }, failing('x is not a function'))).toEqual({ ok: false, code: 'recipient_key_unavailable' })
	})
})
