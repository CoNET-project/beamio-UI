/**
 * the draft / pending state machine (chatDraftState.ts), pure.
 */
import { mayReplace, nextDraft, restoreDraft, toPending, unconfirmedMessage, type DraftRecord } from './chatDraftState'

let n = 0
const mk = () => `send-${++n}`

describe('nextDraft', () => {
	beforeEach(() => { n = 0 })

	it('makes the sendId when the draft is created and keeps it (and the creation time) while it stays a draft', () => {
		const a = nextDraft(undefined, 'h', 1000, mk)
		const b = nextDraft(a, 'he', 1100, mk)
		const c = nextDraft(b, 'hel', 1200, mk)
		expect([a.sendId, b.sendId, c.sendId]).toEqual(['send-1', 'send-1', 'send-1'])
		expect([a.createdAt, b.createdAt, c.createdAt]).toEqual([1000, 1000, 1000])
		expect([a.v, b.v, c.v]).toEqual([1, 2, 3])
		expect(c.updatedAt).toBe(1200)
		expect(c.phase).toBe('draft')
	})

	it('the click does not make a new sendId: pending keeps it, with a higher version', () => {
		const d = nextDraft(undefined, 'hello', 1000, mk)
		const p = toPending(d, 1500)
		expect(p.sendId).toBe(d.sendId)
		expect(p.text).toBe('hello')
		expect(p.v).toBeGreaterThan(d.v)
		expect(p.phase).toBe('pending')
	})

	it('the next thing typed after a pending record is a new message: new sendId, version goes on', () => {
		const p = toPending(nextDraft(undefined, 'one', 1000, mk), 1500)
		const next = nextDraft(p, 'two', 2000, mk)
		expect(next.sendId).not.toBe(p.sendId)
		expect(next.v).toBeGreaterThan(p.v)
		expect(next.createdAt).toBe(2000)
		expect(next.phase).toBe('draft')
	})

	it('an older version never replaces a newer one', () => {
		const a = nextDraft(undefined, 'a', 1, mk)
		const b = nextDraft(a, 'ab', 2, mk)
		expect(mayReplace(undefined, a)).toBe(true)
		expect(mayReplace(a, b)).toBe(true)
		expect(mayReplace(b, a)).toBe(false)
		expect(mayReplace(b, b)).toBe(false)
	})
})

describe('restoreDraft', () => {
	const draft: DraftRecord = { v: 3, sendId: 'd1', text: 'half typed', createdAt: 1, updatedAt: 2, phase: 'draft' }

	it('a draft goes back into the input', () => {
		expect(restoreDraft({ draft }, new Set())).toEqual({ inputDraft: draft })
	})

	it('a whitespace-only draft is not restored', () => {
		expect(restoreDraft({ draft: { ...draft, text: '  \n ' } }, new Set())).toEqual({})
	})

	it('a draft whose sendId is already a queued message or a listed message is the clicked message: it is dropped, never put back as text', () => {
		expect(restoreDraft({ draft }, new Set(['d1']))).toEqual({ dropDraft: draft })
		expect(restoreDraft({ draft }, new Set(['other']))).toEqual({ inputDraft: draft })
	})

	it('nothing stored restores nothing', () => {
		expect(restoreDraft(undefined, new Set())).toEqual({})
		expect(restoreDraft({}, new Set())).toEqual({})
	})
})

describe('unconfirmedMessage', () => {
	it('is a failed, retryable message with the same sendId and time, and the copy key "unconfirmed"', () => {
		const rec: DraftRecord = { v: 2, sendId: 'abcdef123456', text: 'x', createdAt: 77, updatedAt: 78, phase: 'pending' }
		const m = unconfirmedMessage(rec)
		expect(m).toMatchObject({ sendId: 'abcdef123456', text: 'x', createdAt: 77, status: 'failed', sendError: 'unconfirmed', from: 'me' })
		expect(m.id).toBe('tmp_77_abcdef12')
	})
})
