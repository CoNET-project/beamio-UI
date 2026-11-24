/**
 * @jest-environment node
 */
/** The receipt path of a shell is decided at run time by the hello capability; older shells and the browser behave as before. SYNTHETIC. */
let mockShell = true
let mockHello: { answered: boolean; capabilities: string[] } | null = null
jest.mock('./shellContext', () => ({ isShellContext: () => mockShell }))
jest.mock('./nativeChatRouteRegister', () => ({ getCachedHello: () => mockHello }))

import { nativeReceiptPath, receiptCapabilityDeclaredBy, RECEIPT_SENDER_CAPABILITY } from './receiptCapability'

describe('nativeReceiptPath', () => {
	beforeEach(() => {
		mockShell = true
		mockHello = null
	})
	it('no valid hello yet, or a hello without the capability (an older shell): false, so the page sends no routes and keeps its own receipt code', () => {
		expect(nativeReceiptPath()).toBe(false)
		mockHello = { answered: true, capabilities: ['identity.native-keys.v1', 'inbound.deferAck'] }
		expect(nativeReceiptPath()).toBe(false)
	})
	it('a hello that declares the capability: true, so the page sends routes and skips its own receipt code', () => {
		mockHello = { answered: true, capabilities: ['identity.native-keys.v1', RECEIPT_SENDER_CAPABILITY] }
		expect(nativeReceiptPath()).toBe(true)
	})
	it('the browser is never on this path, whatever a hello says', () => {
		mockShell = false
		mockHello = { answered: true, capabilities: [RECEIPT_SENDER_CAPABILITY] }
		expect(nativeReceiptPath()).toBe(false)
	})
	it('the pure check', () => {
		expect(receiptCapabilityDeclaredBy(null)).toBe(false)
		expect(receiptCapabilityDeclaredBy({ capabilities: [] })).toBe(false)
		expect(receiptCapabilityDeclaredBy({ capabilities: [RECEIPT_SENDER_CAPABILITY] })).toBe(true)
	})
})
