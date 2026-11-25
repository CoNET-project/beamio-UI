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
	nativeEoa: async () => ({ kind: 'address', eoa: E }), // the device wallet is the record's wallet unless a test says otherwise
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
	it('both hosts unregistered: resume at the FIRST read (one read, no wait)', async () => {
		expect(await resumeCreateCheck(E, deps())).toEqual({ kind: 'resume', tag: TAG })
		expect(reads.sort()).toEqual(['P', 'S']) // exactly one read per host
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
		nowMs += RESUME_B1_NO_ACK_MS + MIN
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

	const HOUR = 60 * MIN
	const boundary = async (afterMs: number) => {
		// first read after the wait, then a second read 2 min later (B2 met); the verdict of the second read decides
		nowMs += afterMs
		await resumeCreateCheck(E, deps())
		monoMs += RESUME_B2_READ_GAP_MS
		nowMs += RESUME_B2_READ_GAP_MS
		return resumeCreateCheck(E, deps())
	}

	it('without a, B1 is 30 min since s: 29 min does not route, 31 min does', async () => {
		expect(RESUME_B1_NO_ACK_MS).toBe(30 * MIN)
		expect(await boundary(27 * MIN)).toMatchObject({ kind: 'uncertain', why: 'min_wait' }) // 27 + 2 = 29 min
		resetResumeCreateForTest()
		nowMs = 1_800_000_000_000
		monoMs = 10_000
		expect(await boundary(29 * MIN)).toEqual({ kind: 'resume', tag: TAG }) // 29 + 2 = 31 min
	})

	it('with a (the server said ok:true) B1 is 24 h since a: 23 h does not route, 25 h does', async () => {
		markPendingForwardAccepted(E, sentAt())
		expect(RESUME_B1_WITH_ACK_MS).toBe(24 * HOUR)
		expect(await boundary(23 * HOUR - 2 * MIN)).toMatchObject({ kind: 'uncertain', why: 'min_wait' }) // 23 h
		resetResumeCreateForTest()
		nowMs = 1_800_000_000_000
		monoMs = 10_000
		expect(await boundary(25 * HOUR - 2 * MIN)).toEqual({ kind: 'resume', tag: TAG }) // 25 h
	})

	it('with a, the old 30 min and the old 5 min waits do not route', async () => {
		markPendingForwardAccepted(E, sentAt())
		expect(await boundary(60 * MIN)).toMatchObject({ kind: 'uncertain', why: 'min_wait' })
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

describe('the device wallet must be the record wallet before a resume is routed (walletEoaAddress, trusted window channel)', () => {
	const MIX = '0x' + 'aB'.repeat(20)
	const neverCalled = () => {
		const calls = { n: 0 }
		return { calls, fn: async () => { calls.n += 1; return { kind: 'address' as const, eoa: E } } }
	}
	it('the same wallet (any case): routed, at the first read when step 3 was never sent', async () => {
		writePendingCreateTag(E, TAG)
		expect(await resumeCreateCheck(E, deps({ nativeEoa: async () => ({ kind: 'address', eoa: E.toUpperCase().replace('0X', '0x') }) }))).toEqual({ kind: 'resume', tag: TAG })
	})
	it('the native answer in checksum (mixed) case, the record wallet in lower case: routed', async () => {
		writePendingCreateTag(MIX.toLowerCase(), TAG)
		expect(await resumeCreateCheck(MIX.toLowerCase(), deps({ nativeEoa: async () => ({ kind: 'address', eoa: MIX }) }))).toEqual({ kind: 'resume', tag: TAG })
	})
	it('the record wallet asked in mixed case, the native answer in lower case: routed', async () => {
		writePendingCreateTag(MIX.toLowerCase(), TAG)
		expect(await resumeCreateCheck(MIX, deps({ nativeEoa: async () => ({ kind: 'address', eoa: MIX.toLowerCase() }) }))).toEqual({ kind: 'resume', tag: TAG })
	})
	it('another wallet: not routed (home, record kept)', async () => {
		writePendingCreateTag(E, TAG)
		const v = await resumeCreateCheck(E, deps({ nativeEoa: async () => ({ kind: 'address', eoa: '0x' + '2'.repeat(40) }) }))
		expect(v).toMatchObject({ kind: 'uncertain', why: 'native_eoa_mismatch' })
		expect(readPendingCreateRecord(E)).not.toBeNull()
	})
	it.each([
		['locked', async () => ({ kind: 'refused' as const, code: 'locked' })],
		['unavailable', async () => ({ kind: 'refused' as const, code: 'unavailable' })],
		['no_key', async () => ({ kind: 'refused' as const, code: 'no_key' })],
		['origin_refused', async () => ({ kind: 'refused' as const, code: 'origin_refused' })],
		['no answer (null)', async () => null],
		['throws', async () => { throw new Error('x') }],
		['never answers', () => new Promise<null>(() => undefined)],
	])('%s: treated as "cannot get the wallet now": not routed, not a mismatch, not "no tag"', async (_n, nativeEoa) => {
		writePendingCreateTag(E, TAG)
		const v = await resumeCreateCheck(E, deps({ nativeEoa: nativeEoa as never }))
		expect(v).toMatchObject({ kind: 'uncertain', why: 'native_eoa_unavailable' })
		expect(readPendingCreateRecord(E)).not.toBeNull()
	})
	it('the B path (step 3 may have been sent) asks it too, only once B is met', async () => {
		writePendingCreateTag(E, TAG)
		markPendingForwardSent(E, nowMs)
		const n = neverCalled()
		nowMs += RESUME_B1_NO_ACK_MS + MIN
		await resumeCreateCheck(E, deps({ nativeEoa: n.fn }))
		expect(n.calls.n).toBe(0) // B2 not met yet: not asked
		monoMs += RESUME_B2_READ_GAP_MS
		nowMs += RESUME_B2_READ_GAP_MS
		expect(await resumeCreateCheck(E, deps({ nativeEoa: n.fn }))).toEqual({ kind: 'resume', tag: TAG })
		expect(n.calls.n).toBe(1)
	})
	it('not asked without a record, and not when the registry says registered or the hosts disagree', async () => {
		const n = neverCalled()
		await resumeCreateCheck(E, deps({ nativeEoa: n.fn }))
		writePendingCreateTag(E, TAG)
		secondary = 'registered'
		await resumeCreateCheck(E, deps({ nativeEoa: n.fn }))
		writePendingCreateTag(E, TAG)
		secondary = 'unknown'
		await resumeCreateCheck(E, deps({ nativeEoa: n.fn }))
		expect(n.calls.n).toBe(0)
	})
})
