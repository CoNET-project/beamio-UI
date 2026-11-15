/**
 * a shell without identity.native-keys.v1 shows the unified chat-unavailable state and is not blocked; a real not-ready
 * keeps the existing prompt. Pure table tests; the entry gate wiring is pinned in AppEntryGate.identityCapability.static.test.ts.
 */
import { identityCapabilityFrom, shellEntryFor } from './shellEntryDecision'

const NOT_READY = { status: 'not_ready' as const }
const UNKNOWN = { status: 'unknown' as const }
const NO_KEY = { status: 'no_key' as const }
const LOCKED = { status: 'locked' as const, eoa: '0x' + '11'.repeat(20) }
const UNLOCKED = { status: 'unlocked' as const, eoa: '0x' + '22'.repeat(20) }

describe('identityCapabilityFrom', () => {
	it('an answer that lists identity.native-keys.v1 is declared', () => {
		expect(identityCapabilityFrom({ answered: true, capabilities: ['identity.provision', 'identity.native-keys.v1'] })).toBe('declared')
	})

	it('an answer without it is missing (the shell answered, so it is not an unanswered shell)', () => {
		expect(identityCapabilityFrom({ answered: true, capabilities: ['inbound.deferAck', 'inbound.generation.v1'] })).toBe('missing')
		expect(identityCapabilityFrom({ answered: true, capabilities: [] })).toBe('missing')
	})

	it('no answer to hello is unanswered, whatever the list says', () => {
		expect(identityCapabilityFrom({ answered: false, capabilities: [] })).toBe('unanswered')
	})
})

describe('shellEntryFor', () => {
	it('capability missing, no account known (not_ready): the unified chat-unavailable state, not the not-ready prompt', () => {
		expect(shellEntryFor('missing', NOT_READY)).toBe('chat_unavailable')
	})

	it('capability missing, unknown or no_key: the unified state, and never the page-wallet path', () => {
		expect(shellEntryFor('missing', UNKNOWN)).toBe('chat_unavailable')
		expect(shellEntryFor('missing', NO_KEY)).toBe('chat_unavailable')
	})

	it('capability missing but an account is locked or unlocked: enter the app on its public address (other features stay usable)', () => {
		expect(shellEntryFor('missing', LOCKED)).toBe('enter_native')
		expect(shellEntryFor('missing', UNLOCKED)).toBe('enter_native')
	})

	it('capability declared and not_ready: the existing native-status path, so the real not-ready prompt is kept', () => {
		expect(shellEntryFor('declared', NOT_READY)).toBe('native_status')
		expect(shellEntryFor('declared', UNKNOWN)).toBe('native_status')
	})

	it('unanswered hello: the existing native-status path, as before', () => {
		expect(shellEntryFor('unanswered', NOT_READY)).toBe('native_status')
	})
})

describe('the identity-missing init and entry decisions', () => {
	const { nativeInitAllowed, missingIdentityNotReadyEntry } = jest.requireActual<typeof import('./shellEntryDecision')>('./shellEntryDecision')

	it('an init is never allowed when the capability is missing; declared and unanswered keep the existing path', () => {
		expect(nativeInitAllowed('missing')).toBe(false)
		expect(nativeInitAllowed('declared')).toBe(true)
		expect(nativeInitAllowed('unanswered')).toBe(true)
	})

	it('capability missing with a known public address: the local home; without one: the unified state, never the import page', () => {
		expect(missingIdentityNotReadyEntry(true)).toBe('local_home')
		expect(missingIdentityNotReadyEntry(false)).toBe('unified_unavailable')
	})
})
