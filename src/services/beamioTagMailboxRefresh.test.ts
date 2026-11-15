import type { NetworkSource } from './chatNetworkGate'

// Jest here has no '@/' alias, so the app modules are virtual mocks.
const mockMirror: Record<string, any> = {}
const mockPresence = jest.fn()
const mockWake = jest.fn()
const mockSearchTag = jest.fn()

jest.mock('@/services/chat', () => ({
	refreshChatMailboxPresence: (...a: unknown[]) => mockPresence(...a),
	refreshPeerNativeWakeable: (...a: unknown[]) => mockWake(...a),
}), { virtual: true })

jest.mock('@/services/beamioTagWorkerBridge', () => ({
	getBeamioTagMirrorMap: () => mockMirror,
	mergeBeamioTagTrusted: async (patch: Record<string, any>) => { Object.assign(mockMirror, patch) },
	searchBeamioTagRemote: (...a: unknown[]) => mockSearchTag(...a),
}), { virtual: true })

// eslint-disable-next-line import/first
import { BEAMIO_TAG_FAILS_TO_STOP, startBeamioTagMailboxRefresh } from './beamioTagMailboxRefresh'

class FakeNet implements NetworkSource {
	online = true
	private listeners = new Set<() => void>()
	isOnline() { return this.online }
	onOnline(cb: () => void) {
		this.listeners.add(cb)
		return () => { this.listeners.delete(cb) }
	}
	goOnline() {
		this.online = true
		this.listeners.forEach(cb => cb())
	}
}

const ROUTE = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nroute\n-----END PGP PUBLIC KEY BLOCK-----'
const addr = (i: number) => '0x' + (i + 1).toString(16).padStart(40, '0')
const profile = (n: number) => ({
	privateKeyArmor: '0x' + '11'.repeat(32),
	chats: Array.from({ length: n }, (_, i) => ({ address: addr(i), chatData: { routersArmoreds: ROUTE } })),
})

const settle = async () => {
	for (let i = 0; i < 2000; i++) await Promise.resolve()
}

describe('startBeamioTagMailboxRefresh network rules', () => {
	let stop: (() => void) | undefined
	const sleeps: number[] = []
	const sleep = async (ms: number) => { sleeps.push(ms) }

	beforeEach(() => {
		jest.useFakeTimers()
		for (const k of Object.keys(mockMirror)) delete mockMirror[k]
		mockPresence.mockReset()
		mockWake.mockReset()
		mockSearchTag.mockReset().mockResolvedValue(undefined)
		sleeps.length = 0
	})
	afterEach(() => {
		stop?.()
		stop = undefined
		jest.useRealTimers()
	})

	it('sends nothing while offline, then starts after a 3–15 s random delay', async () => {
		const net = new FakeNet()
		net.online = false
		mockPresence.mockImplementation(async ([c]: any[]) => new Map([[c.address, true]]))
		mockWake.mockResolvedValue({ ok: true, nativeWakeable: true })
		stop = startBeamioTagMailboxRefresh(() => profile(25), { net, sleep, random: () => 0.5 })
		await settle()
		jest.advanceTimersByTime(600_000)
		await settle()
		expect(mockPresence).not.toHaveBeenCalled()
		expect(mockWake).not.toHaveBeenCalled()
		expect(mockSearchTag).not.toHaveBeenCalled()

		net.goOnline()
		jest.advanceTimersByTime(8_999)
		await settle()
		expect(mockPresence).not.toHaveBeenCalled()
		jest.advanceTimersByTime(1)
		await settle()
		expect(mockPresence).toHaveBeenCalledTimes(25)
		expect(mockWake).toHaveBeenCalledTimes(25)
		// 300 ms between contacts: 24 gaps for 25 contacts.
		expect(sleeps).toEqual(Array(24).fill(300))
	})

	it('stops the batch after three failed probes in a row (was 25 in the airplane log)', async () => {
		const net = new FakeNet()
		mockPresence.mockResolvedValue(new Map())
		mockWake.mockResolvedValue(null)
		stop = startBeamioTagMailboxRefresh(() => profile(25), { net, sleep, random: () => 0 })
		await settle()
		expect(mockPresence).toHaveBeenCalledTimes(BEAMIO_TAG_FAILS_TO_STOP)
		expect(mockWake).toHaveBeenCalledTimes(BEAMIO_TAG_FAILS_TO_STOP)

		// The next batch (180 s later) starts at the 4th contact, not the 1st.
		mockPresence.mockImplementation(async ([c]: any[]) => new Map([[c.address, false]]))
		mockWake.mockResolvedValue({ ok: true, nativeWakeable: false })
		jest.advanceTimersByTime(180_000)
		await settle()
		const firstOfNext = mockPresence.mock.calls[BEAMIO_TAG_FAILS_TO_STOP][0][0].address
		expect(firstOfNext).toBe(addr(BEAMIO_TAG_FAILS_TO_STOP))
	})

	it('stops mid-batch when the device goes offline and resumes at that contact', async () => {
		const net = new FakeNet()
		let calls = 0
		mockPresence.mockImplementation(async ([c]: any[]) => {
			calls += 1
			if (calls === 2) net.online = false
			return new Map([[c.address, true]])
		})
		mockWake.mockResolvedValue({ ok: true, nativeWakeable: true })
		stop = startBeamioTagMailboxRefresh(() => profile(10), { net, sleep, random: () => 0 })
		await settle()
		expect(mockPresence).toHaveBeenCalledTimes(2)
		// Offline: no 180 s timer runs a batch.
		jest.advanceTimersByTime(600_000)
		await settle()
		expect(mockPresence).toHaveBeenCalledTimes(2)
		net.goOnline()
		jest.advanceTimersByTime(3_000)
		await settle()
		expect(mockPresence.mock.calls[2][0][0].address).toBe(addr(2))
		expect(mockPresence).toHaveBeenCalledTimes(10)
	})

	it('skips fresh contacts without a gap or a request', async () => {
		const net = new FakeNet()
		const now = Date.now()
		for (let i = 0; i < 5; i++) {
			mockMirror[addr(i)] = { addressLower: addr(i), updatedAt: now, onlineAt: now, nativeWakeAt: now }
		}
		stop = startBeamioTagMailboxRefresh(() => profile(5), { net, sleep, now: () => now + 1_000 })
		await settle()
		expect(mockPresence).not.toHaveBeenCalled()
		expect(mockWake).not.toHaveBeenCalled()
		expect(sleeps).toEqual([])
	})
})
