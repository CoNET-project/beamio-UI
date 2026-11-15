/**
 * the new Android result codes and their copy keys. Unknown codes use the generic retry copy.
 */
import { NATIVE_RECOVERY_RESULT_CODES, nativeRecoveryCopyKey } from './nativeRecovery'
import en from '../locale/en.json'
import zh from '../locale/zh-CN.json'

const lookup = (dotted: string, locale: any): unknown =>
	dotted.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), locale)

describe('native result codes', () => {
	it('the four new codes, unknown and the four reviewer codes are in the list', () => {
		for (const c of ['unregister_refused', 'clear_failed', 'busy', 'main_thread', 'unknown', 'not_ready', 'invalid_key', 'invalid_mnemonic', 'address_mismatch']) {
			expect(NATIVE_RECOVERY_RESULT_CODES).toContain(c)
		}
	})
	it('the four new codes map to the copy keys named by the; unknown falls back to the generic copy', () => {
		expect(nativeRecoveryCopyKey('unregister_refused')).toBe('import.unregister_refused')
		expect(nativeRecoveryCopyKey('busy')).toBe('recovery.native.busy')
		expect(nativeRecoveryCopyKey('clear_failed')).toBe('recovery.native.import_incomplete')
		expect(nativeRecoveryCopyKey('main_thread')).toBe('recovery.native.import_incomplete')
		expect(nativeRecoveryCopyKey('unknown')).toBe('recovery.native.import_incomplete')
	})
	it('existing codes keep the native page copy (no PWA copy key), legacy_record keeps its copy', () => {
		for (const c of ['bad_pin', 'backoff', 'not_found', 'network_error', 'ok', 'cancelled', 'invalid_key', 'invalid_mnemonic', 'address_mismatch']) {
			expect(nativeRecoveryCopyKey(c)).toBeNull()
		}
		expect(nativeRecoveryCopyKey('legacy_record')).toBe('recovery.native.legacy_record')
		expect(nativeRecoveryCopyKey('not_ready')).toBe('recovery.native.not_ready')
	})
	it('every copy key the mapping can return exists in both locales', () => {
		const keys = new Set<string>()
		for (const c of [...NATIVE_RECOVERY_RESULT_CODES, 'legacy_record']) {
			const k = nativeRecoveryCopyKey(c)
			if (k) keys.add(k)
		}
		for (const k of keys) {
			expect(typeof lookup(k, en)).toBe('string')
			expect(typeof lookup(k, zh)).toBe('string')
		}
		expect(keys.size).toBe(5)
	})
})
