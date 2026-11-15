/**
 * @jest-environment node
 */
/**
 * the one-time verification prompt is due for an existing contact without a verified key, until the user has dismissed it or verified.
 */
import { storedKeyFingerprint } from '@/utils/pgpFingerprint'
import { oneTimeVerifyPromptDue } from './verifyPrompt'

describe('oneTimeVerifyPromptDue', () => {
	it('is due for an existing contact with no verified key and no dismissal', () => {
		expect(oneTimeVerifyPromptDue({ chatData: {} })).toBe(true)
		expect(oneTimeVerifyPromptDue({ chatData: { verifiedFingerprint: 'f'.repeat(64) } })).toBe(true) // unlabelled value: not a verification
	})

	it('is not due once the contact is verified (scheme-tagged value)', () => {
		expect(oneTimeVerifyPromptDue({ chatData: { verifiedFingerprint: storedKeyFingerprint('a'.repeat(40)) } })).toBe(false)
	})

	it('is not due after the user dismissed it for this contact', () => {
		expect(oneTimeVerifyPromptDue({ verifyPromptSeen: true, chatData: {} })).toBe(false)
	})

	it('is not due without a chat record', () => {
		expect(oneTimeVerifyPromptDue(null)).toBe(false)
		expect(oneTimeVerifyPromptDue(undefined)).toBe(false)
	})
})
