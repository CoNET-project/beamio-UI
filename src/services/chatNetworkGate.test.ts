import { presenceDelayMs, recoveryJitterMs, startNetworkAwareLoop, type NetworkSource } from './chatNetworkGate'

class FakeNet implements NetworkSource {
	online = true
	private listeners = new Set<() => void>()
	isOnline() { return this.online }
	onOnline(cb: () => void) {
		this.listeners.add(cb)
		return () => { this.listeners.delete(cb) }
	}
	goOffline() { this.online = false }
	goOnline() {
		this.online = true
		this.listeners.forEach(cb => cb())
	}
	get listenerCount() { return this.listeners.size }
}

const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('presenceDelayMs', () => {
	it('keeps 6 s after one failure, then doubles up to 60 s', () => {
		expect([0, 1, 2, 3, 4, 5, 9].map(n => presenceDelayMs(n, 6_000, 60_000)))
			.toEqual([6_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000])
	})
})

describe('recoveryJitterMs', () => {
	it('stays inside [min, max)', () => {
		expect(recoveryJitterMs(500, 3_000, () => 0)).toBe(500)
		expect(recoveryJitterMs(500, 3_000, () => 0.999)).toBe(2_997)
	})
})

describe('startNetworkAwareLoop', () => {
	beforeEach(() => jest.useFakeTimers())
	afterEach(() => jest.useRealTimers())

	const start = (net: FakeNet, probe: jest.Mock) => startNetworkAwareLoop({
		probe,
		intervalMs: 6_000,
		maxBackoffMs: 60_000,
		recoveryMinMs: 500,
		recoveryMaxMs: 3_000,
		net,
		random: () => 0.5,
	})

	it('probes every 6 s while replies come back', async () => {
		const net = new FakeNet()
		const probe = jest.fn().mockResolvedValue(true)
		const stop = start(net, probe)
		await flush()
		expect(probe).toHaveBeenCalledTimes(1)
		for (let i = 0; i < 5; i++) {
			jest.advanceTimersByTime(6_000)
			await flush()
		}
		expect(probe).toHaveBeenCalledTimes(6)
		stop()
	})

	it('sends nothing while offline (the 36 s airplane window of 2026-11-11)', async () => {
		const net = new FakeNet()
		net.goOffline()
		const probe = jest.fn().mockResolvedValue(false)
		const stop = start(net, probe)
		await flush()
		jest.advanceTimersByTime(36_000)
		await flush()
		expect(probe).not.toHaveBeenCalled()
		stop()
	})

	it('stops at the next tick once the device goes offline', async () => {
		const net = new FakeNet()
		const probe = jest.fn().mockResolvedValue(true)
		const stop = start(net, probe)
		await flush()
		net.goOffline()
		jest.advanceTimersByTime(120_000)
		await flush()
		expect(probe).toHaveBeenCalledTimes(1)
		stop()
	})

	it('resumes once, after a random delay, when the network comes back', async () => {
		const net = new FakeNet()
		net.goOffline()
		const probe = jest.fn().mockResolvedValue(true)
		const stop = start(net, probe)
		await flush()
		net.goOnline()
		jest.advanceTimersByTime(1_749)
		await flush()
		expect(probe).not.toHaveBeenCalled()
		jest.advanceTimersByTime(1)
		await flush()
		expect(probe).toHaveBeenCalledTimes(1)
		// A second online event before the timer fires replaces it, not adds one.
		net.goOffline()
		jest.advanceTimersByTime(6_000)
		await flush()
		net.goOnline()
		net.goOnline()
		jest.advanceTimersByTime(1_750)
		await flush()
		expect(probe).toHaveBeenCalledTimes(2)
		stop()
	})

	it('backs off when probes fail but the WebView still says online', async () => {
		const net = new FakeNet()
		const probe = jest.fn().mockResolvedValue(false)
		const stop = start(net, probe)
		await flush()
		// 0 s, 6 s, +12 s, +24 s, +48 s, +60 s => 6 probes in 150 s (was 26 at a flat 6 s).
		for (let t = 0; t < 150_000; t += 1_000) {
			jest.advanceTimersByTime(1_000)
			await flush()
		}
		expect(probe).toHaveBeenCalledTimes(6)
		stop()
	})

	it('treats a throwing probe as a failure and keeps going', async () => {
		const net = new FakeNet()
		const probe = jest.fn().mockRejectedValue(new Error('boom'))
		const stop = start(net, probe)
		await flush()
		jest.advanceTimersByTime(6_000)
		await flush()
		expect(probe).toHaveBeenCalledTimes(2)
		stop()
	})

	it('stop() clears the timer and the online listener', async () => {
		const net = new FakeNet()
		const probe = jest.fn().mockResolvedValue(true)
		const stop = start(net, probe)
		await flush()
		expect(net.listenerCount).toBe(1)
		stop()
		expect(net.listenerCount).toBe(0)
		jest.advanceTimersByTime(60_000)
		net.goOnline()
		jest.advanceTimersByTime(60_000)
		await flush()
		expect(probe).toHaveBeenCalledTimes(1)
	})
})
