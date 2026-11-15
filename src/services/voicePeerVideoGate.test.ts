import {
	VIDEO_OFF_REPEAT_MS,
	acceptPeerFrame,
	applyPeerVideoControl,
	isStalePeerFrame,
	newPeerVideoGate,
} from './voicePeerVideoGate'

describe('voicePeerVideoGate', () => {
	it('drops frames captured before the camera went off, shows later ones', () => {
		const g = newPeerVideoGate()
		expect(acceptPeerFrame(g, 1000)).toBe(true)
		expect(applyPeerVideoControl(g, 'disable', 2000)).toBe(true)
		expect(g.off).toBe(true)
		// In flight when the camera went off: arrives late.
		expect(acceptPeerFrame(g, 1900)).toBe(false)
		expect(acceptPeerFrame(g, 2000)).toBe(false)
		// Captured after "off": the camera is on again even if "on" was lost.
		expect(acceptPeerFrame(g, 2600)).toBe(true)
		expect(g.off).toBe(false)
		// Still drops old frames afterwards.
		expect(acceptPeerFrame(g, 1950)).toBe(false)
	})

	it('on → off → on with an "on" control', () => {
		const g = newPeerVideoGate()
		applyPeerVideoControl(g, 'disable', 2000)
		expect(applyPeerVideoControl(g, 'enable', 5000)).toBe(true)
		expect(g.off).toBe(false)
		expect(acceptPeerFrame(g, 5100)).toBe(true)
		expect(acceptPeerFrame(g, 1990)).toBe(false)
	})

	it('ignores a repeated "off" that arrives after the camera came back on', () => {
		// The repeat carries the original "off" time, so it is older than "on".
		const g = newPeerVideoGate()
		applyPeerVideoControl(g, 'disable', 2000)
		applyPeerVideoControl(g, 'enable', 3000)
		expect(applyPeerVideoControl(g, 'disable', 2000)).toBe(false)
		expect(g.off).toBe(false)
		// A repeat of the same "off" while still off is harmless.
		const k = newPeerVideoGate()
		applyPeerVideoControl(k, 'disable', 2000)
		expect(applyPeerVideoControl(k, 'disable', 2000)).toBe(true)
		expect(k.off).toBe(true)
		expect(k.offAt).toBe(2000)
		const h = newPeerVideoGate()
		applyPeerVideoControl(h, 'disable', 2000)
		applyPeerVideoControl(h, 'enable', 3000)
		expect(applyPeerVideoControl(h, 'disable', 1999)).toBe(false)
		expect(h.off).toBe(false)
		expect(acceptPeerFrame(h, 3100)).toBe(true)
	})

	it('BJPG frames (no capture time) only while the camera is on', () => {
		const g = newPeerVideoGate()
		expect(acceptPeerFrame(g, 0)).toBe(true)
		applyPeerVideoControl(g, 'disable', 2000)
		expect(acceptPeerFrame(g, 0)).toBe(false)
		applyPeerVideoControl(g, 'enable', 3000)
		expect(acceptPeerFrame(g, 0)).toBe(true)
	})

	it('a frame queued for display goes stale when "off" lands meanwhile', () => {
		const g = newPeerVideoGate()
		expect(acceptPeerFrame(g, 1800)).toBe(true)
		applyPeerVideoControl(g, 'disable', 2000)
		expect(isStalePeerFrame(g, 1800)).toBe(true)
	})

	it('controls without a usable timestamp still apply, and never move offAt back', () => {
		const g = newPeerVideoGate()
		applyPeerVideoControl(g, 'disable', 4000)
		expect(applyPeerVideoControl(g, 'enable', undefined)).toBe(true)
		expect(g.off).toBe(false)
		expect(applyPeerVideoControl(g, 'disable', 'x')).toBe(true)
		expect(g.off).toBe(true)
		expect(g.offAt).toBe(4000)
	})

	it('repeats "off" at 0, 1.5 and 4 s', () => {
		expect([...VIDEO_OFF_REPEAT_MS]).toEqual([0, 1500, 4000])
	})
})
