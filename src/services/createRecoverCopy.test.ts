import { createRecoverCopyKey } from './createRecoverCopy'
import en from '../locale/en.json'
import zh from '../locale/zh-CN.json'

describe('create page copy for the fail-closed reuse outcomes', () => {
	it('mnemonic_missing and existing_key_required have their own copy keys, not the generic local error', () => {
		expect(createRecoverCopyKey('mnemonic_missing')).toBe('create_account_mnemonic_missing')
		expect(createRecoverCopyKey('existing_key_required')).toBe('create_account_existing_key_required')
	})
	it('other local steps keep the generic local error copy', () => {
		expect(createRecoverCopyKey('local_wallet_unconfirmed')).toBe('create_account_local_error')
		expect(createRecoverCopyKey('reuse_key_changed')).toBe('create_account_existing_key_required')  //
		expect(createRecoverCopyKey(undefined)).toBe('create_account_local_error')
	})
	it('each copy key exists in both locales and never suggests a new wallet', () => {
		for (const key of ['create_account_mnemonic_missing', 'create_account_existing_key_required']) {
			const e = (en as any).ui[key] as string
			const z = (zh as any).ui[key] as string
			expect(typeof e).toBe('string')
			expect(typeof z).toBe('string')
			expect(e.toLowerCase()).not.toMatch(/create a new|new wallet|generate/)
		}
	})
})
