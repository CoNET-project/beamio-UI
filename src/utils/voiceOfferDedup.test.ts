import {
	createVoiceOfferDedup,
	voiceOfferDedupKey,
	voiceOfferWithinLateWindow,
	VOICE_OFFER_DEDUP_GLOBAL_CAP,
	VOICE_OFFER_DEDUP_PER_CALLER_CAP,
	VOICE_OFFER_DEDUP_RETAIN_MS,
} from './voiceOfferDedup'

const memStorage = () => {
	const m = new Map<string, string>()
	return {
		getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
		setItem: (k: string, v: string) => {
			m.set(k, v)
		},
	}
}

const R1 = '0x1111111111111111111111111111111111111111'
const R2 = '0x2222222222222222222222222222222222222222'
const T0 = 1_800_000_000_000

describe('dedup key (draft-v36 §40, draft-v37 §29)', () => {
	test('key is JSON array of [callId, sessionId], not | or :', () => {
		expect(voiceOfferDedupKey('c1', 's1')).toBe('["c1","s1"]')
		expect(voiceOfferDedupKey(' c1 ', 's:1')).toBe('["c1","s:1"]')
		expect(voiceOfferDedupKey('a|b', 'c')).not.toBe(voiceOfferDedupKey('a', 'b|c'))
	})
})

describe('register: duplicate and retention', () => {
	test('first offer accepted, same key refused while retained', () => {
		const d = createVoiceOfferDedup({ storage: null })
		expect(d.register('c1', 's1', R1, T0)).toEqual({ ok: true })
		expect(d.register('c1', 's1', R1, T0 + 1000)).toEqual({ ok: false, reason: 'duplicate' })
	})

	test('record is kept until 1200 s after registration, then evicted', () => {
		const d = createVoiceOfferDedup({ storage: null })
		d.register('c1', 's1', R1, T0)
		expect(d.register('c1', 's1', R1, T0 + VOICE_OFFER_DEDUP_RETAIN_MS)).toEqual({ ok: false, reason: 'duplicate' })
		expect(d.register('c1', 's1', R1, T0 + VOICE_OFFER_DEDUP_RETAIN_MS + 1)).toEqual({ ok: true })
	})
})

describe('per-caller quota (draft-v36 §40 1)', () => {
	test('51st unexpired offer from one R is refused, other R unaffected', () => {
		const warnings: string[] = []
		const d = createVoiceOfferDedup({ storage: null, warn: (m) => warnings.push(m) })
		for (let i = 0; i < VOICE_OFFER_DEDUP_PER_CALLER_CAP; i += 1) {
			expect(d.register(`c${i}`, `s${i}`, R1, T0)).toEqual({ ok: true })
		}
		expect(d.register('cx', 'sx', R1, T0)).toEqual({ ok: false, reason: 'caller_quota' })
		expect(warnings.length).toBe(1)
		expect(d.register('cy', 'sy', R2, T0)).toEqual({ ok: true })
	})

	test('quota frees once that R records expire', () => {
		const d = createVoiceOfferDedup({ storage: null, warn: () => {} })
		for (let i = 0; i < VOICE_OFFER_DEDUP_PER_CALLER_CAP; i += 1) d.register(`c${i}`, `s${i}`, R1, T0)
		const later = T0 + VOICE_OFFER_DEDUP_RETAIN_MS + 1
		expect(d.register('cx', 'sx', R1, later)).toEqual({ ok: true })
	})

	test('caller compared case-insensitively', () => {
		const d = createVoiceOfferDedup({ storage: null, warn: () => {} })
		for (let i = 0; i < VOICE_OFFER_DEDUP_PER_CALLER_CAP; i += 1) d.register(`c${i}`, `s${i}`, R1.toUpperCase(), T0)
		expect(d.register('cx', 'sx', R1.toLowerCase(), T0)).toEqual({ ok: false, reason: 'caller_quota' })
	})
})

describe('global cap (draft-v36 §40 2–3)', () => {
	test('full table of unexpired records refuses new offers and evicts none', () => {
		const warnings: string[] = []
		const d = createVoiceOfferDedup({ storage: null, warn: (m) => warnings.push(m) })
		// spread across many callers so the per-caller cap does not trigger first
		for (let i = 0; i < VOICE_OFFER_DEDUP_GLOBAL_CAP; i += 1) {
			const caller = `0x${(i + 1).toString(16).padStart(40, '0')}`
			expect(d.register(`c${i}`, `s${i}`, caller, T0)).toEqual({ ok: true })
		}
		expect(d.register('new', 'new', '0x' + 'f'.repeat(40), T0)).toEqual({ ok: false, reason: 'global_full' })
		expect(warnings.some((w) => w.includes('dedup table full'))).toBe(true)
		// the first record is still there: a replay of it is still a duplicate
		expect(d.register('c0', 's0', '0x' + '0'.repeat(39) + '1', T0)).toEqual({ ok: false, reason: 'duplicate' })
	})

	test('expired records are evicted so new offers fit again', () => {
		const d = createVoiceOfferDedup({ storage: null, warn: () => {} })
		for (let i = 0; i < VOICE_OFFER_DEDUP_GLOBAL_CAP; i += 1) {
			d.register(`c${i}`, `s${i}`, `0x${(i + 1).toString(16).padStart(40, '0')}`, T0)
		}
		const later = T0 + VOICE_OFFER_DEDUP_RETAIN_MS + 1
		expect(d.register('new', 'new', '0x' + 'f'.repeat(40), later)).toEqual({ ok: true })
	})
})

describe('persistence', () => {
	test('records survive a reload from storage', () => {
		const storage = memStorage()
		const d1 = createVoiceOfferDedup({ storage })
		d1.register('c1', 's1', R1, T0)
		const d2 = createVoiceOfferDedup({ storage })
		expect(d2.register('c1', 's1', R1, T0 + 1)).toEqual({ ok: false, reason: 'duplicate' })
	})

	test('corrupt storage is treated as empty, not a crash', () => {
		const storage = memStorage()
		storage.setItem('beamio.voiceOfferDedup.v1', '{not json')
		const d = createVoiceOfferDedup({ storage })
		expect(d.register('c1', 's1', R1, T0)).toEqual({ ok: true })
	})
})

describe('late window (draft-v37 §41)', () => {
	const expiresAt = T0 + 900_000
	test('accepted while now <= signed expiresAt', () => {
		expect(voiceOfferWithinLateWindow({ expiresAt, createdAt: expiresAt - 900_000 }, expiresAt)).toBe(true)
		expect(voiceOfferWithinLateWindow({ expiresAt, createdAt: expiresAt - 900_000 }, expiresAt - 1)).toBe(true)
	})
	test('refused once now > signed expiresAt', () => {
		expect(voiceOfferWithinLateWindow({ expiresAt, createdAt: expiresAt - 900_000 }, expiresAt + 1)).toBe(false)
		expect(voiceOfferWithinLateWindow({ expiresAt, createdAt: expiresAt - 900_000 }, expiresAt + 300_000)).toBe(false)
	})
	test('seconds and milliseconds both normalise', () => {
		const sec = Math.floor(expiresAt / 1000)
		expect(voiceOfferWithinLateWindow({ expiresAt: sec, createdAt: sec - 900 }, expiresAt - 1000)).toBe(true)
		expect(voiceOfferWithinLateWindow({ expiresAt: sec, createdAt: sec - 900 }, expiresAt + 1000)).toBe(false)
	})
	test('expiresAt is never extended by 300 s (v39 §43)', () => {
		expect(voiceOfferWithinLateWindow({ expiresAt, createdAt: expiresAt - 900_000 }, expiresAt + 1)).toBe(false)
	})
	test('issuedAt more than 300 s in the future is refused; the past is not', () => {
		const now = expiresAt - 60_000
		expect(voiceOfferWithinLateWindow({ expiresAt, createdAt: now + 300_001 }, now)).toBe(false)
		expect(voiceOfferWithinLateWindow({ expiresAt, createdAt: now + 300_000 }, now)).toBe(true)
		expect(voiceOfferWithinLateWindow({ expiresAt, createdAt: now - 3_600_000 }, now)).toBe(true)
	})
	test('missing issue time (createdAt) is refused (v20 §22)', () => {
		expect(voiceOfferWithinLateWindow({ expiresAt }, expiresAt - 1000)).toBe(false)
		expect(voiceOfferWithinLateWindow({ expiresAt, createdAt: 0 }, expiresAt - 1000)).toBe(false)
	})
	test('missing or invalid expiresAt is refused', () => {
		expect(voiceOfferWithinLateWindow({}, T0)).toBe(false)
		expect(voiceOfferWithinLateWindow({ expiresAt: 'x' }, T0)).toBe(false)
		expect(voiceOfferWithinLateWindow(null, T0)).toBe(false)
	})
})
