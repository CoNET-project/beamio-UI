// the text under a message that was not sent: only a real held / lookup failure says the contact's key is unavailable; a message cut off by a kill says it is unconfirmed.
import { fetchTypeErrorWording, isFetchNetworkTypeError, isProgrammingError } from './recipientRecord'

jest.mock('@/locale/beamioLocale', () => ({ tu: (key: string) => key }))
// eslint-disable-next-line import/first
import { sendFailedDetailText } from './recipientCopy'

describe('sendFailedDetailText', () => {
	it('unconfirmed / interrupted / persist_failed / identity_not_ready have their own copy, never the key-unavailable copy', () => {
		expect(sendFailedDetailText('interrupted')).toBe('chat.failed.interrupted')
		expect(sendFailedDetailText('unconfirmed')).toBe('chat.failed.unconfirmed')
		expect(sendFailedDetailText('persist_failed')).toBe('chat.failed.persist_failed')
		expect(sendFailedDetailText('identity_not_ready')).toBe('chat.failed.identity_not_ready')
		for (const code of ['interrupted', 'unconfirmed', 'persist_failed', 'identity_not_ready', 'send_failed', 'anything_else', '']) {
			expect(sendFailedDetailText(code)).not.toBe('chat.held.unavailable.banner')
		}
	})
	it('a code that is not known is a plain failed send (retry), not a held key copy', () => {
		expect(sendFailedDetailText('something_new')).toBe('chat.failed.send_failed')
		expect(sendFailedDetailText('send_failed')).toBe('chat.failed.send_failed')
	})
	it('a real recipient failure keeps its own copy (the key IS unavailable / the network failed)', () => {
		expect(sendFailedDetailText('recipient_key_unavailable')).toBe('chat.held.unavailable.banner')
		expect(sendFailedDetailText('network_error')).toBe('chat.held.network_error.banner')
		expect(sendFailedDetailText('route_unconfirmed')).toBe('chat.held.route_unconfirmed.banner')
		expect(sendFailedDetailText('first_fetch_pending')).toBe('chat.held.first_fetch_pending.banner')
		expect(sendFailedDetailText('fingerprint_changed')).toBe('chat.held.fingerprint_changed.banner')
	})
})

describe('fetch network wordings are network failures, not programming errors', () => {
	const te = (m: string) => Object.assign(new TypeError(m), {})
	it('Chrome, Safari / WKWebView, Firefox, undici and the iOS system wordings', () => {
		for (const m of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'fetch failed', 'The network connection was lost.', 'The Internet connection appears to be offline.', 'The request timed out.', 'A server with the specified hostname could not be found.', 'Could not connect to the server.', 'cancelled', 'Network request failed']) {
			expect(isFetchNetworkTypeError(te(m))).toBe(true)
			expect(isProgrammingError(te(m))).toBe(false)
			expect(fetchTypeErrorWording(te(m))).toBeTruthy()
		}
	})
	it('a TypeError that is our own bug stays a programming error', () => {
		for (const m of ["Cannot read properties of undefined (reading 'x')", 'x is not a function', 'Invalid URL']) {
			expect(isFetchNetworkTypeError(te(m))).toBe(false)
			expect(isProgrammingError(te(m))).toBe(true)
		}
	})
})
