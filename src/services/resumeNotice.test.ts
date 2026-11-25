/** 0.53.51 one-time notices: once per wallet and kind, one at a time, non-secret flags only. SYNTHETIC values only. */
import { dismissResumeNotice, getResumeNotice, pushResumeNotice, subscribeResumeNotice } from './resumeNotice'

const E = '0x' + '1'.repeat(40)
const F = '0x' + '2'.repeat(40)
beforeEach(() => {
	localStorage.clear()
	dismissResumeNotice()
})

describe('resumeNotice', () => {
	it('shows once per wallet and kind; the second push is refused even after dismissal', () => {
		expect(pushResumeNotice('code_not_shown', E)).toBe(true)
		expect(getResumeNotice()).toEqual({ kind: 'code_not_shown', eoa: E })
		dismissResumeNotice()
		expect(getResumeNotice()).toBeNull()
		expect(pushResumeNotice('code_not_shown', E)).toBe(false)
		expect(getResumeNotice()).toBeNull()
	})
	it('the two kinds and two wallets are independent', () => {
		expect(pushResumeNotice('code_not_shown', E)).toBe(true)
		expect(pushResumeNotice('already_registered_keep_password', E)).toBe(true)
		expect(getResumeNotice()?.kind).toBe('already_registered_keep_password')
		expect(pushResumeNotice('code_not_shown', F)).toBe(true)
	})
	it('the address is case-insensitive; a bad address shows nothing', () => {
		expect(pushResumeNotice('code_not_shown', E.toUpperCase().replace('0X', '0x'))).toBe(true)
		expect(pushResumeNotice('code_not_shown', E)).toBe(false)
		expect(pushResumeNotice('code_not_shown', 'nope')).toBe(false)
	})
	it('the stored flag is booleans under the wallet only (no tag, no secret)', () => {
		pushResumeNotice('code_not_shown', E)
		pushResumeNotice('already_registered_keep_password', E)
		expect(JSON.parse(localStorage.getItem('beamio.codeNoticeShown.v1') as string)).toEqual({ [E]: { d3: true, n1: true } })
	})
	it('listeners are told on push and dismiss, and can unsubscribe', () => {
		const l = jest.fn()
		const off = subscribeResumeNotice(l)
		pushResumeNotice('code_not_shown', E)
		dismissResumeNotice()
		expect(l).toHaveBeenCalledTimes(2)
		off()
		pushResumeNotice('code_not_shown', F)
		expect(l).toHaveBeenCalledTimes(2)
	})
	it('a corrupt stored value is treated as nothing shown', () => {
		localStorage.setItem('beamio.codeNoticeShown.v1', '{bad')
		expect(pushResumeNotice('code_not_shown', E)).toBe(true)
	})
})
