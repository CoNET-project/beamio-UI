/**
 * The resume-create decision (0.53.51, design r1..r4): record, condition A (two hosts, both unregistered), condition B (B1 wall clock AND B2 two reads in
 * this process apart on the monotonic clock), the older string record, the clock going back, a hung read, and the idle-only event.
 * SYNTHETIC values only; reads and clocks are injected.
 */
import { clearPendingCreateTag, markPendingForwardAccepted, markPendingForwardSent, readPendingCreateRecord, writePendingCreateTag } from './pendingCreateTag'
import {
	RESUME_B1_NO_ACK_MS,
	RESUME_B1_WITH_ACK_MS,
	RESUME_B2_READ_GAP_MS,
	flushQueuedResume,
	hasPendingCreateRecord,
	isIdleForResume,
	markResumeFired,
	registerResumeBusyProbe,
	requestResumeRoute,
	resetResumeCreateForTest,
	resumeCreateCheck,
	type ResumeDeps,
} from './resumeCreate'
import type { RegistrationState } from './beamio'

const KEY = 'beamio.pendingCreateTag.v2'
const E = '0x' + '1'.repeat(40)
const TAG = 'synthtag'
const MIN = 60_000

let nowMs = 1_800_000_000_000
let monoMs = 10_000
let primary: RegistrationState | 'hang' = 'unregistered'
let secondary: RegistrationState | 'hang' = 'unregistered'
const reads: string[] = []

const deps = (over: Partial<ResumeDeps> = {}): ResumeDeps => ({
	now: () => nowMs,
	mono: () => monoMs,
	read: (url) => {
		reads.push(url)
		const v = url === 'P' ? primary : secondary
		return v === 'hang' ? new Promise<RegistrationState>(() => undefined) : Promise.resolve(v)
	},
	primaryUrl: 'P',
	secondaryUrl: 'S',
	timeoutMs: 20,
	...over,
})

beforeEach(() => {
	localStorage.clear()
	resetResumeCreateForTest()
	nowMs = 1_800_000_000_000
	monoMs = 10_000
	primary = 'unregistered'
	secondary = 'unregistered'
	reads.length = 0
})

describe('no record: nothing is read', () => {
	it('returns none with no registry read at all', async () => {
		expect(hasPendingCreateRecord(E)).toBe(false)
		expect(await resumeCreateCheck(E, deps())).toEqual({ kind: 'none' })
		expect(reads).toEqual([])
	})
	it("another wallet's record does not count", async () => {
		writePendingCreateTag('0x' + '2'.repeat(40), TAG)
		expect(await resumeCreateCheck(E, deps())).toEqual({ kind: 'none' })
		expect(reads).toEqual([])
	})
})

describe('step 3 never sent (no s): condition A alone', () => {
	beforeEach(() => writePendingCreateTag(E, TAG))
	it('both hosts unregistered: resume, at the first read', async () => {
		expect(await resumeCreateCheck(E, deps())).toEqual({ kind: 'resume', tag: TAG })
		expect(reads.sort()).toEqual(['P', 'S'])
	})
	it.each([
		['the primary fails', 'unknown', 'unregistered'],
		['the second fails', 'unregistered', 'unknown'],
		['both fail', 'unknown', 'unknown'],
	] as const)('%s: uncertain, nothing routed, the record stays', async (_n, p, q) => {
		primary = p
		secondary = q
		const v = await resumeCreateCheck(E, deps())
		expect(v).toMatchObject({ kind: 'uncertain' })
		expect(readPendingCreateRecord(E)).not.toBeNull()
	})
	it('a hung host (never answers) is uncertain after the timeout, not a wait without end', async () => {
		secondary = 'hang'
		expect(await resumeCreateCheck(E, deps())).toMatchObject({ kind: 'uncertain', why: 'read_failed' })
	})
	it('registered on either host: the record is cleared and the verdict is registered', async () => {
		primary = 'unregistered'
		secondary = 'registered'
		expect(await resumeCreateCheck(E, deps())).toEqual({ kind: 'registered' })
		expect(readPendingCreateRecord(E)).toBeNull()
		writePendingCreateTag(E, TAG)
		primary = 'registered'
		secondary = 'unregistered'
		expect(await resumeCreateCheck(E, deps())).toEqual({ kind: 'registered' })
		expect(readPendingCreateRecord(E)).toBeNull()
	})
})

describe('older string record (s unknown): A alone, B counts as met', () => {
	beforeEach(() => localStorage.setItem(KEY, JSON.stringify({ [E]: TAG })))
	it('one read with both hosts unregistered routes', async () => {
		expect(await resumeCreateCheck(E, deps())).toEqual({ kind: 'resume', tag: TAG })
	})
	it('A not met (hosts differ): not routed', async () => {
		secondary = 'registered'
		expect(await resumeCreateCheck(E, deps())).toEqual({ kind: 'registered' })
		localStorage.setItem(KEY, JSON.stringify({ [E]: TAG }))
		secondary = 'unknown'
		expect(await resumeCreateCheck(E, deps())).toMatchObject({ kind: 'uncertain' })
	})
})

describe('step 3 may have been sent (s): B1 (wall clock) AND B2 (two reads, monotonic gap)', () => {
	const sentAt = () => nowMs
	beforeEach(() => {
		writePendingCreateTag(E, TAG)
		markPendingForwardSent(E, sentAt())
	})

	it('a fresh s: not routed; the first read starts the B2 count', async () => {
		nowMs += 10_000
		expect(await resumeCreateCheck(E, deps())).toMatchObject({ kind: 'uncertain', why: 'min_wait' })
	})

	it('B1 met but B2 not (one read only, or two reads closer than 2 min): not routed', async () => {
		nowMs += RESUME_B1_NO_ACK_MS + MIN
		expect(await resumeCreateCheck(E, deps())).toMatchObject({ kind: 'uncertain', why: 'second_read_pending' })
		monoMs += RESUME_B2_READ_GAP_MS - 1000
		expect(await resumeCreateCheck(E, deps())).toMatchObject({ kind: 'uncertain', why: 'second_read_pending' })
	})

	it('B2 met but B1 not (two reads 2 min apart, still before 5 min since s): not routed', async () => {
		nowMs += 60_000
		await resumeCreateCheck(E, deps())
		monoMs += RESUME_B2_READ_GAP_MS + 1000
		nowMs += RESUME_B2_READ_GAP_MS + 1000
		expect(nowMs - sentAt()).toBeLessThan(RESUME_B1_NO_ACK_MS)
		expect(await resumeCreateCheck(E, deps())).toMatchObject({ kind: 'uncertain', why: 'min_wait' })
	})

	it('both met: B1 (>= 5 min since s) and B2 (second read >= 2 min after the first on the monotonic clock) route', async () => {
		nowMs += RESUME_B1_NO_ACK_MS + MIN
		await resumeCreateCheck(E, deps())
		monoMs += RESUME_B2_READ_GAP_MS
		nowMs += RESUME_B2_READ_GAP_MS
		expect(await resumeCreateCheck(E, deps())).toEqual({ kind: 'resume', tag: TAG })
	})

	it('wall clock moved FORWARD while the monotonic clock did not: B1 met, B2 not, so not routed', async () => {
		nowMs += 6 * MIN
		await resumeCreateCheck(E, deps())
		nowMs += 6 * MIN // the system time is set forward; performance.now did not move
		expect(await resumeCreateCheck(E, deps())).toMatchObject({ kind: 'uncertain', why: 'second_read_pending' })
	})

	it('wall clock went BACK (now < s): uncertain, whatever else', async () => {
		nowMs = sentAt() - 1000
		expect(await resumeCreateCheck(E, deps())).toMatchObject({ kind: 'uncertain', why: 'clock_went_back' })
	})

	it('a read that is not "unregistered" on both hosts resets the B2 count', async () => {
		nowMs += RESUME_B1_NO_ACK_MS + MIN
		await resumeCreateCheck(E, deps())
		monoMs += RESUME_B2_READ_GAP_MS + 1000
		secondary = 'unknown'
		await resumeCreateCheck(E, deps())
		secondary = 'unregistered'
		monoMs += 1000
		expect(await resumeCreateCheck(E, deps())).toMatchObject({ kind: 'uncertain', why: 'second_read_pending' })
	})

	it('with a (the server answered 2xx) B1 is 30 min: 29 min does not route, 31 min does', async () => {
		markPendingForwardAccepted(E, sentAt())
		nowMs += 29 * MIN
		await resumeCreateCheck(E, deps())
		monoMs += RESUME_B2_READ_GAP_MS
		expect(await resumeCreateCheck(E, deps())).toMatchObject({ kind: 'uncertain', why: 'min_wait' })
		nowMs += 2 * MIN
		monoMs += RESUME_B2_READ_GAP_MS
		expect(await resumeCreateCheck(E, deps())).toEqual({ kind: 'resume', tag: TAG })
		expect(RESUME_B1_WITH_ACK_MS).toBe(30 * MIN)
	})

	it('B1 counts from a when there is one (not from the earlier s)', async () => {
		nowMs += 40 * MIN
		markPendingForwardAccepted(E, nowMs - 10 * MIN)
		await resumeCreateCheck(E, deps())
		monoMs += RESUME_B2_READ_GAP_MS
		expect(await resumeCreateCheck(E, deps())).toMatchObject({ kind: 'uncertain', why: 'min_wait' })
	})
})

describe('the idle-only route event (D4)', () => {
	it('starts once per wallet per process; a repeat is dropped', () => {
		const start = jest.fn()
		expect(requestResumeRoute(E, TAG, start)).toBe('started')
		expect(requestResumeRoute(E, TAG, start)).toBe('dropped')
		expect(start).toHaveBeenCalledTimes(1)
	})

	it('a wallet already routed by the gate (markResumeFired) is dropped', () => {
		markResumeFired(E)
		const start = jest.fn()
		expect(requestResumeRoute(E, TAG, start)).toBe('dropped')
		expect(start).not.toHaveBeenCalled()
	})

	it.each(['a call', 'the settings', 'the unlock screen', 'a native flow', 'the create page'])('while %s is on it waits, and it starts on the next idle flush', (_what) => {
		let busy = true
		const off = registerResumeBusyProbe(() => busy)
		const start = jest.fn()
		expect(requestResumeRoute(E, TAG, start)).toBe('queued')
		expect(flushQueuedResume(start)).toBe('busy')
		expect(start).not.toHaveBeenCalled()
		busy = false
		expect(isIdleForResume()).toBe(true)
		expect(flushQueuedResume(start)).toBe('started')
		expect(start).toHaveBeenCalledWith(E, TAG)
		expect(flushQueuedResume(start)).toBe('idle')
		off()
	})

	it('a throwing probe counts as busy (never starts on a doubt)', () => {
		const off = registerResumeBusyProbe(() => {
			throw new Error('x')
		})
		expect(requestResumeRoute(E, TAG, jest.fn())).toBe('queued')
		off()
	})

	it('after a routed resume that completed (record cleared) there is no new route', async () => {
		writePendingCreateTag(E, TAG)
		markResumeFired(E)
		clearPendingCreateTag(E)
		expect(await resumeCreateCheck(E, deps())).toEqual({ kind: 'none' })
		expect(requestResumeRoute(E, TAG, jest.fn())).toBe('dropped')
	})
})
