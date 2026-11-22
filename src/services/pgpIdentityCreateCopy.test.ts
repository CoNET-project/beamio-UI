/**
 * r2h and r2g each result code that the page shows has copy in both locales; the success codes share one copy; cas_conflict has a refusal copy;
 * the copy avoids the forbidden wording. SYNTHETIC values only.
 */
import { identityCreateCopyKey, identityCreateIsSuccess } from './pgpIdentityCreateCopy'
import en from '../locale/en.json'
import zhCN from '../locale/zh-CN.json'

const ui = (d: unknown) => (d as { ui: Record<string, string> }).ui

describe('identity create copy', () => {
	it('pending_exists and native_confirmation_missing map to their refusal keys', () => {
		expect(identityCreateCopyKey('pending_exists')).toBe('chat.identity_create.pending_exists')
		expect(identityCreateCopyKey('native_confirmation_missing')).toBe('chat.identity_create.confirmation_missing')
	})

	it('idempotent and already_registered_same_key share the success copy', () => {
		expect(identityCreateCopyKey('idempotent')).toBe('chat.identity_create.success')
		expect(identityCreateCopyKey('already_registered_same_key')).toBe('chat.identity_create.success')
		expect(identityCreateIsSuccess('idempotent')).toBe(true)
		expect(identityCreateIsSuccess('already_registered_same_key')).toBe(true)
		expect(identityCreateIsSuccess('cas_conflict')).toBe(false)
	})

	it('cas_conflict has a refusal copy', () => {
		expect(identityCreateCopyKey('cas_conflict')).toBe('chat.identity_create.conflict')
	})

	it('r2p confirmation_not_native shares the confirmation-missing copy; already_exists is its own refusal', () => {
		expect(identityCreateCopyKey('confirmation_not_native')).toBe('chat.identity_create.confirmation_missing')
		expect(identityCreateCopyKey('already_exists')).toBe('chat.identity_create.already_exists')
		expect(identityCreateIsSuccess('already_exists')).toBe(false)
		expect(identityCreateIsSuccess('confirmation_not_native')).toBe(false)
	})

	it('index z retry_write is a retryable refusal, never a success', () => {
		expect(identityCreateCopyKey('retry_write')).toBe('chat.identity_create.retry')
		expect(identityCreateIsSuccess('retry_write')).toBe(false)
	})

	it('index an write_reverted is a retryable refusal, never a success', () => {
		expect(identityCreateCopyKey('write_reverted')).toBe('chat.identity_create.retry')
		expect(identityCreateIsSuccess('write_reverted')).toBe(false)
	})

	it('a code outside the table has no message (already_registered is withdrawn)', () => {
		expect(identityCreateCopyKey('already_registered')).toBeNull()
		expect(identityCreateCopyKey('not_eligible')).toBeNull()
	})

	it('every mapped key has a title and a body in both locales', () => {
		const keys = [
			'chat.identity_create.pending_exists',
			'chat.identity_create.confirmation_missing',
			'chat.identity_create.success',
			'chat.identity_create.conflict',
			'chat.identity_create.already_exists',
			'chat.identity_create.retry',
		]
		for (const d of [en, zhCN]) {
			for (const k of keys) {
				expect(ui(d)[`${k}.title`]).toBeTruthy()
				expect(ui(d)[`${k}.body`]).toBeTruthy()
			}
		}
	})

	it('no identity-create copy uses the forbidden wording', () => {
		for (const d of [en, zhCN]) {
			for (const [k, v] of Object.entries(ui(d))) {
				if (!k.startsWith('chat.identity_create.')) continue
				expect(v).not.toContain('找回私钥')
				expect(v).not.toContain('找回钱包')
			}
		}
	})
})
