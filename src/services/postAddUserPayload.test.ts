/**
 * @jest-environment node
 */
/**
 * The forward of the native payload to /api/addUser sends the body exactly as given (clarification 2). SYNTHETIC.
 */
import { postAddUserPayload } from './beamio'

jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
jest.mock('@/services/argon2WorkerBridge', () => ({}))
jest.mock('@/workers/appDaemon/client', () => ({}))
jest.mock('@/workers/beamioTag/client', () => ({}))
jest.mock('@/services/chatWorkerBridge', () => ({}))
jest.mock('@/services/chatMediaWorkerBridge', () => ({}))

describe('postAddUserPayload', () => {
	const WALLET = '0xabcdef0123456789abcdef0123456789abcdef01'
	const body = { accountName: 'synthtag', recover: [{ hash: '0xh1', encrypto: 'encA' }], wallet: WALLET, signMessage: '0x' + 'ab'.repeat(65) }
	const real = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = real
	})

	it('posts the JSON of the body unchanged: the sent wallet is the given wallet, character for character', async () => {
		const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		expect(await postAddUserPayload(body)).toEqual({ kind: 'ok' })
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toMatch(/\/api\/addUser$/)
		expect(init.method).toBe('POST')
		const sent = JSON.parse(String(init.body)) as typeof body
		expect(sent.wallet).toBe(WALLET)
		expect(sent.signMessage).toBe(body.signMessage)
		expect(sent).toEqual(body)
	})

	it('maps the outcome: 2xx ok, an HTTP status keeps its number, a thrown fetch is a network failure', async () => {
		globalThis.fetch = jest.fn(async () => ({ ok: false, status: 409 })) as unknown as typeof fetch
		expect(await postAddUserPayload(body)).toEqual({ kind: 'http', status: 409 })
		globalThis.fetch = jest.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
		expect(await postAddUserPayload(body)).toEqual({ kind: 'network' })
	})
})
