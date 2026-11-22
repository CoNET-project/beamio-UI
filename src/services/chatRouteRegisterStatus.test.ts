/**
 * The registration POST's HTTP status is classified in the SDK rule: 2xx accepted; 4xx refused (never retried automatically); 5xx and no
 * answer retried with the backoff. SYNTHETIC values only.
 */
import { classifyRegisterStatus, submitBrowserChatRouteRegister, type RouteRegisterFields } from './chatRouteRegister'

const FIELDS = { wallet: '0x' + '9'.repeat(40), keyID: 'K', publicKeyArmored: 'P', encrypKeyArmored: 'E', routeKeyID: 'R', timestamp: 1, nonce: '0x01' } as unknown as RouteRegisterFields
const sign = async () => 'SIG'

describe('the registration status class (SDK rule)', () => {
	it('2xx accepted; 4xx refused; 5xx server; no answer network', () => {
		expect(classifyRegisterStatus(200)).toBe('accepted')
		expect(classifyRegisterStatus(409)).toBe('refused')
		expect(classifyRegisterStatus(401)).toBe('refused')
		expect(classifyRegisterStatus(503)).toBe('server')
		expect(classifyRegisterStatus(null)).toBe('network')
	})

	it('a 4xx answer is refused and never retried automatically (the reason says so)', async () => {
		expect(await submitBrowserChatRouteRegister(FIELDS, { signInPage: sign, post: async () => ({ ok: false, status: 409 }) })).toEqual({ ok: false, reason: 'refused_4xx' })
	})

	it('a 5xx answer is a server failure, retried with the backoff; no answer is a network failure', async () => {
		expect(await submitBrowserChatRouteRegister(FIELDS, { signInPage: sign, post: async () => ({ ok: false, status: 503 }) })).toEqual({ ok: false, reason: 'server_5xx' })
		expect(await submitBrowserChatRouteRegister(FIELDS, { signInPage: sign, post: async () => ({ ok: false, status: null }) })).toEqual({ ok: false, reason: 'network' })
	})

	it('a success is accepted; a caller that reports no status keeps the older reason', async () => {
		expect(await submitBrowserChatRouteRegister(FIELDS, { signInPage: sign, post: async () => ({ ok: true, status: 200 }) })).toEqual({ ok: true })
		expect(await submitBrowserChatRouteRegister(FIELDS, { signInPage: sign, post: async () => ({ ok: false }) })).toEqual({ ok: false, reason: 'server_rejected' })
	})
})
