import { renderHook } from '@testing-library/react'
import { playbackErrorMessage, startVideoFromTap, toggleMediaPlayback, useStableMediaManifest } from './mediaPlaybackControl'

class FakeMedia {
	paused = true
	playImpl: () => Promise<void> = async () => { this.paused = false }
	play = jest.fn(() => this.playImpl())
	pause = jest.fn(() => { this.paused = true })
}

const named = (name: string) => Object.assign(new Error(name), { name })

describe('toggleMediaPlayback', () => {
	it('plays, pauses and resumes a voice message', async () => {
		const el = new FakeMedia()
		await expect(toggleMediaPlayback(el, 'voice')).resolves.toEqual({ state: 'playing' })
		await expect(toggleMediaPlayback(el, 'voice')).resolves.toEqual({ state: 'paused' })
		await expect(toggleMediaPlayback(el, 'voice')).resolves.toEqual({ state: 'playing' })
		expect(el.play).toHaveBeenCalledTimes(2)
		expect(el.pause).toHaveBeenCalledTimes(1)
	})

	it('calls play() in the same tick as the tap (keeps the user gesture)', () => {
		const el = new FakeMedia()
		void toggleMediaPlayback(el, 'video')
		expect(el.play).toHaveBeenCalledTimes(1)
	})

	it('reports an unsupported format', async () => {
		const el = new FakeMedia()
		el.playImpl = async () => { throw named('NotSupportedError') }
		await expect(toggleMediaPlayback(el, 'video')).resolves.toEqual({
			state: 'error',
			message: 'Video format is not supported on this device.',
		})
	})

	it('asks for another tap when the gesture was not accepted', async () => {
		const el = new FakeMedia()
		el.playImpl = async () => { throw named('NotAllowedError') }
		await expect(toggleMediaPlayback(el, 'voice')).resolves.toEqual({
			state: 'error',
			message: 'Tap again to play the voice message.',
		})
	})

	it('gives a generic message for other failures and for a missing element', async () => {
		const el = new FakeMedia()
		el.playImpl = async () => { throw new Error('boom') }
		await expect(toggleMediaPlayback(el, 'voice')).resolves.toEqual({ state: 'error', message: 'Voice message could not be played.' })
		await expect(toggleMediaPlayback(null, 'video')).resolves.toEqual({ state: 'error', message: 'Video could not be played.' })
	})
})

describe('playbackErrorMessage', () => {
	it('maps error names', () => {
		expect(playbackErrorMessage('voice', named('NotSupportedError'))).toBe('Voice message format is not supported on this device.')
		expect(playbackErrorMessage('video', named('NotAllowedError'))).toBe('Tap again to play the video.')
		expect(playbackErrorMessage('video', undefined)).toBe('Video could not be played.')
	})
})

describe('useStableMediaManifest', () => {
	it('keeps the first object while a refresh passes an equal copy', () => {
		const first = { fragmentHash: '0xaa', key: 'k', iv: 'i', name: 'clip.mp4' }
		const { result, rerender } = renderHook(({ m }) => useStableMediaManifest(m), { initialProps: { m: first } })
		expect(result.current).toBe(first)
		rerender({ m: { ...first } })
		expect(result.current).toBe(first)
		rerender({ m: JSON.parse(JSON.stringify(first)) })
		expect(result.current).toBe(first)
	})

	it('switches when the fragment changes', () => {
		const first = { fragmentHash: '0xaa', key: 'k', iv: 'i' }
		const next = { fragmentHash: '0xbb', key: 'k', iv: 'i' }
		const { result, rerender } = renderHook(({ m }) => useStableMediaManifest(m), { initialProps: { m: first } })
		rerender({ m: next })
		expect(result.current).toBe(next)
	})
})

describe('startVideoFromTap', () => {
	const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
	const video = (o: Partial<{ ended: boolean; duration: number; currentTime: number }> = {}) => {
		const v: any = { paused: true, ended: false, duration: 5, currentTime: 0, ...o }
		v.play = jest.fn(async () => { v.paused = false })
		return v
	}

	it('plays once from the middle', async () => {
		const v = video({ currentTime: 2 })
		const onError = jest.fn()
		const timers: Array<() => void> = []
		startVideoFromTap(v, onError, (cb) => timers.push(cb))
		await flush()
		expect(v.play).toHaveBeenCalledTimes(1)
		expect(timers).toHaveLength(0)
		expect(onError).not.toHaveBeenCalled()
	})

	it('near the end: seeks to 0, and the 50 ms retry is skipped once playing', async () => {
		const v = video({ ended: true, currentTime: 5 })
		const onError = jest.fn()
		const timers: Array<() => void> = []
		startVideoFromTap(v, onError, (cb) => timers.push(cb))
		expect(v.currentTime).toBe(0)
		await flush()
		timers.forEach(t => t())
		await flush()
		expect(v.play).toHaveBeenCalledTimes(1)
		expect(onError).not.toHaveBeenCalled()
	})

	it('an interrupted first play() (AbortError) is not reported; the retry starts the video', async () => {
		const v = video({ ended: true, currentTime: 5 })
		v.play = jest.fn()
			.mockImplementationOnce(async () => { throw Object.assign(new Error('interrupted'), { name: 'AbortError' }) })
			.mockImplementationOnce(async () => { v.paused = false })
		const onError = jest.fn()
		const timers: Array<() => void> = []
		startVideoFromTap(v, onError, (cb) => timers.push(cb))
		await flush()
		timers.forEach(t => t())
		await flush()
		expect(v.play).toHaveBeenCalledTimes(2)
		expect(onError).not.toHaveBeenCalled()
	})

	it('a rejection after the video is already playing is not reported', async () => {
		const v = video({ ended: true, currentTime: 5 })
		v.play = jest.fn(async () => { v.paused = false; throw Object.assign(new Error('late'), { name: 'NotAllowedError' }) })
		const onError = jest.fn()
		startVideoFromTap(v, onError, () => {})
		await flush()
		expect(onError).not.toHaveBeenCalled()
	})

	it('reports an unsupported format while still paused', async () => {
		const v = video()
		v.play = jest.fn(async () => { throw Object.assign(new Error('codec'), { name: 'NotSupportedError' }) })
		const onError = jest.fn()
		startVideoFromTap(v, onError, () => {})
		await flush()
		expect(onError).toHaveBeenCalledWith('Video format is not supported on this device.')
	})
})
