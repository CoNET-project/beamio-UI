/**
 * @jest-environment node
 */
/**
 * the start that the first identity's `registered` triggers read identityPublic before the native public snapshot was refreshed and got not_ready; the
 * ladder then waited 2 s. The first reads after `registered` retry after 300 ms (at most 3), then the ladder goes on unchanged. SYNTHETIC; the native answers are scripted.
 */
jest.mock('@/workers/appDaemon/client', () => ({}))
jest.mock('@/workers/beamioTag/client', () => ({}))
jest.mock('@/services/chatMediaWorkerBridge', () => ({}))
jest.mock('@/services/argon2WorkerBridge', () => ({}))

type Chat = typeof import('./chat')

/** the scripted start: each call reports not_ready through the real retry dependency (as the real start does) until `startedAt` calls were made */
function load(startedAtCall: number) {
	const times: number[] = []
	const start = jest.fn(async (deps: { retry: (reason: string, kind?: string) => void }) => {
		times.push(Date.now())
		if (start.mock.calls.length >= startedAtCall) return 'started'
		deps.retry('identityPublic not_ready', 'not_ready')
		return 'not_ready'
	})
	let chat: Chat | undefined
	jest.isolateModules(() => {
		jest.doMock('@/services/chatWorkerBridge', () => ({
			boundAccountOfActiveClient: () => null,
			applyNativeRouteEligibility: () => 'unchanged',
			clearNativeRouteState: () => undefined,
			pauseNativeChatListen: () => true,
		}))
		jest.doMock('@/services/shellChatCapability', () => ({
			ensureShellChatState: async () => 'native_chat',
			isShellContext: () => true,
			onShellChatCapabilityResolved: () => () => undefined,
			shellChatBlockedNow: () => false,
		}))
		jest.doMock('./shellChatStart', () => ({ ...jest.requireActual('./shellChatStart'), startShellChatFromNativeIdentity: start }))
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		chat = require('./chat')
	})
	return { chat: chat!, start, times }
}
const noop = () => undefined
async function settle() {
	for (let i = 0; i < 40; i++) await Promise.resolve()
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe('the start after `registered` retries a not_ready after 300 ms', () => {
	it('registered, then not_ready: the next start runs 300 ms later, not after the ladder step', async () => {
		const { chat, start } = load(99)
		await chat.initChat(noop, noop, noop, false, noop) // the earlier start: not_ready, ladder retry (1 s) pending
		expect(start).toHaveBeenCalledTimes(1)
		chat.applyFirstIdentityStatus({ state: 'registered' } as never) // starts at once; reads not_ready
		await settle()
		expect(start).toHaveBeenCalledTimes(2)
		jest.advanceTimersByTime(299)
		await settle()
		expect(start).toHaveBeenCalledTimes(2)
		jest.advanceTimersByTime(1)
		await settle()
		expect(start).toHaveBeenCalledTimes(3) // 300 ms after the registered start (it replaced the pending ladder timer)
	})

	it('at most 3 short retries; then the ladder is used', async () => {
		const { chat, start } = load(99)
		await chat.initChat(noop, noop, noop, false, noop)
		chat.applyFirstIdentityStatus({ state: 'registered' } as never)
		await settle()
		for (let i = 0; i < 3; i++) {
			jest.advanceTimersByTime(300)
			await settle()
		}
		expect(start).toHaveBeenCalledTimes(5) // registered start + 3 short retries + the first earlier start
		const before = start.mock.calls.length
		jest.advanceTimersByTime(300)
		await settle()
		expect(start).toHaveBeenCalledTimes(before) // the 4th wait is the ladder (at least 1 s), not 300 ms
	})

	it('a short retry that reads the identity ends it: started, no further start, and a later not_ready uses the ladder again', async () => {
		const { chat, start } = load(3)
		await chat.initChat(noop, noop, noop, false, noop)
		chat.applyFirstIdentityStatus({ state: 'registered' } as never)
		await settle()
		jest.advanceTimersByTime(300)
		await settle()
		expect(start).toHaveBeenCalledTimes(3) // started on the short retry
		jest.advanceTimersByTime(60_000)
		await settle()
		expect(start).toHaveBeenCalledTimes(3)
	})

	it('without a registered event a not_ready keeps the ladder (no 300 ms retry)', async () => {
		const { chat, start } = load(99)
		await chat.initChat(noop, noop, noop, false, noop)
		expect(start).toHaveBeenCalledTimes(1)
		jest.advanceTimersByTime(300)
		await settle()
		expect(start).toHaveBeenCalledTimes(1)
	})

	it('the short retry is wired: registered sets it, the not_ready retry consumes it, a started start clears it (static)', () => {
		const src = require('fs').readFileSync(require('path').join(__dirname, 'chat.ts'), 'utf8')
		expect(src).toMatch(/if \(s\.state === 'registered'\) registeredShortRetriesLeft = REGISTERED_SHORT_RETRIES/)
		expect(src).toMatch(/if \(registeredShortRetriesLeft > 0\) \{[\s\S]*scheduleChatRetry\(reason, args, REGISTERED_SHORT_RETRY_MS\)/)
		expect(src).toMatch(/if \(result === 'started'\) \{\s*registeredShortRetriesLeft = 0/)
	})
})
