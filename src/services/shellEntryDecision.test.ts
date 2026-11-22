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

	it('capability missing and an unlocked account: enter the app on its public address (LK-P8); a locked account is never a release', () => {
		expect(shellEntryFor('missing', LOCKED)).toBe('chat_unavailable')
		expect(shellEntryFor('missing', UNLOCKED)).toBe('enter_native')
	})

	it('capability declared and not_ready: the existing native-status path, so the real not-ready prompt is kept', () => {
		expect(shellEntryFor('declared', NOT_READY)).toBe('native_status')
		expect(shellEntryFor('declared', UNKNOWN)).toBe('native_status')
	})

	it('an unanswered hello (timeout or refusal) is not confirmed: the unified state, never the native-status path', () => {
		expect(shellEntryFor('unanswered', NOT_READY)).toBe('chat_unavailable')
	})
})

describe('the identity-missing init and entry decisions', () => {
	const { nativeInitAllowed, missingIdentityNotReadyEntry } = jest.requireActual<typeof import('./shellEntryDecision')>('./shellEntryDecision')

	it('an init is sent only with a declared capability; missing and unanswered send nothing', () => {
		expect(nativeInitAllowed('missing')).toBe(false)
		expect(nativeInitAllowed('declared')).toBe(true)
		expect(nativeInitAllowed('unanswered')).toBe(false)
	})

	it('capability missing with a known public address: the local home; without one: the unified state, never the import page', () => {
		expect(missingIdentityNotReadyEntry(true)).toBe('local_home')
		expect(missingIdentityNotReadyEntry(false)).toBe('unified_unavailable')
	})
})

// account-select CAP-01/02/05/06/07: the identity entry display of a missing capability.
describe('CAP display (account-select CAP-01/02/05/06/07): unified unavailable only on an explicit no key', () => {
	const { identityEntryDisplay } = jest.requireActual<typeof import('./shellEntryDecision')>('./shellEntryDecision')
	it('CAP-01: capability missing and native no_key: unified_unavailable', () => {
		expect(identityEntryDisplay('missing', { status: 'no_key' })).toBe('unified_unavailable')
	})
	it('CAP-02: capability missing and native absent (the same as no_key, 58(2)(e)): unified_unavailable', () => {
		// the PWA has no separate absent state: the native "absent" answer is reported as no_key
		expect(identityEntryDisplay('missing', { status: 'no_key' })).toBe('unified_unavailable')
	})
	it('CAP-05: capability missing and native unanswered (unknown): none, the start stays in its startup state', () => {
		expect(identityEntryDisplay('missing', { status: 'unknown' })).toBe('none')
	})
	it('CAP-06: capability missing and native not_ready (unreadable): none, not the unified state', () => {
		expect(identityEntryDisplay('missing', { status: 'not_ready', notReadyReason: 'unreadable' })).toBe('none')
	})
	it('CAP-07: capability missing, native no_key, a valid PWA mnemonic: the display is unified_unavailable; the routing to the home is separate (not decided here)', () => {
		expect(identityEntryDisplay('missing', { status: 'no_key' })).toBe('unified_unavailable')
	})
	it('a declared capability never shows the unified state', () => {
		expect(identityEntryDisplay('declared', { status: 'no_key' })).toBe('none')
	})
})
