/**
 * Y.95 nativeImportResult: the codes, the eoa rule (only with ok and already_exists, lowercase only), and the reqId of the import this
 * page opened. SYNTHETIC values only; no key material is ever in a result.
 */
import { acceptNativeImportResult, onNativeImportResult, NATIVE_IMPORT_RESULT_CODES } from './nativeImportResult'
import { lastOpenedImportReqId, openNativeKeyImport } from './nativeKeyState'

const EOA = '0x1111111111111111111111111111111111111111'
const EOA_UPPER = '0x111111111111111111111111111111111111111A'
const payload = (over: Record<string, unknown>) => ({ type: 'nativeImportResult', reqId: 42, code: 'ok', ...over })

describe('acceptNativeImportResult (Y.95)', () => {
	it('exposes the five codes', () => {
		expect([...NATIVE_IMPORT_RESULT_CODES]).toEqual(['ok', 'already_exists', 'import_failed', 'cancelled', 'bad_request'])
	})

	it('a result is accepted only for the reqId of the open import (no open import: refused)', () => {
		expect(acceptNativeImportResult(payload({}), 42)).toEqual({ code: 'ok' })
		expect(acceptNativeImportResult(payload({ reqId: 7 }), 42)).toBeNull()
		expect(acceptNativeImportResult(payload({}), null)).toBeNull()
	})

	it('another type, a missing payload, or an unknown code is refused', () => {
		expect(acceptNativeImportResult({ ...payload({}), type: 'nativeAccountCreateResult' }, 42)).toBeNull()
		expect(acceptNativeImportResult(null, 42)).toBeNull()
		expect(acceptNativeImportResult(payload({ code: 'imported' }), 42)).toBeNull()
	})

	it('eoa is forwarded with ok and already_exists when it is a lowercase address', () => {
		expect(acceptNativeImportResult(payload({ eoa: EOA }), 42)).toEqual({ code: 'ok', eoa: EOA })
		expect(acceptNativeImportResult(payload({ code: 'already_exists', eoa: EOA }), 42)).toEqual({ code: 'already_exists', eoa: EOA })
	})

	it('an uppercase or malformed eoa is not forwarded', () => {
		expect(acceptNativeImportResult(payload({ eoa: EOA_UPPER }), 42)).toEqual({ code: 'ok' })
		expect(acceptNativeImportResult(payload({ eoa: '0x123' }), 42)).toEqual({ code: 'ok' })
	})

	it('an eoa with any other code is not forwarded', () => {
		for (const code of ['import_failed', 'cancelled', 'bad_request']) {
			expect(acceptNativeImportResult(payload({ code, eoa: EOA }), 42)).toEqual({ code })
		}
	})
})

describe('onNativeImportResult subscribes to the open import only', () => {
	beforeEach(() => {
		;(window as unknown as { CashTreesIOS: unknown }).CashTreesIOS = { chatModuleCommand: jest.fn() }
	})

	it('delivers a result with the reqId of the open import, and no other', async () => {
		const opened = openNativeKeyImport(60_000)
		const reqId = lastOpenedImportReqId()
		expect(reqId).not.toBeNull()
		window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: { type: 'ack', reqId, ok: true } } }))
		await expect(opened).resolves.toBe('opened')

		const seen: unknown[] = []
		const off = onNativeImportResult((r) => seen.push(r))
		const emit = (over: Record<string, unknown>) =>
			window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: { type: 'nativeImportResult', reqId, code: 'ok', ...over } } }))
		emit({ reqId: (reqId as number) + 1 })
		emit({ eoa: EOA })
		off()
		emit({ eoa: EOA })
		expect(seen).toEqual([{ code: 'ok', eoa: EOA }])
	})
})
