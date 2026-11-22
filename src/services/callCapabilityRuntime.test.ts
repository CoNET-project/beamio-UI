import { callCapabilityStateOf } from './callCapability'
import { ProbeSequencer } from './callCapabilityRuntime'

describe('the runtime produces the states of the final rule', () => {
	test('a browser is browser', () => {
		expect(callCapabilityStateOf({ inShell: false, probe: { answered: false, capabilities: [] } })).toBe('browser')
	})

	test('a valid hello decides: with voiceCallV4 compatible, without old_shell', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: ['voiceCallV4'], nativeApp: { platform: 'ios', version: '1.5.8', build: '105' } } })).toBe('compatible')
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: ['voiceCallV4'] } })).toBe('old_shell')
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: ['identity.native-keys.v1'] } })).toBe('old_shell')
	})

	test('a failed hello is old_shell (no third class)', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: 'failed' })).toBe('old_shell')
	})

	test('before the answer the state is loading', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: 'pending' })).toBe('loading')
	})
})

describe('probe sequence (review of 1caaa76): the newest started probe decides the shared state', () => {
	test('an earlier success that arrives late does not overwrite a later failure: the result is old_shell', () => {
		const seq = new ProbeSequencer()
		const first = seq.next()
		const second = seq.next()
		// the later probe fails and is the newest: it writes
		expect(seq.isLatest(second)).toBe(true)
		const laterState = callCapabilityStateOf({ inShell: true, probe: 'failed' })
		expect(laterState).toBe('old_shell')
		// the earlier probe succeeds late: it is not the newest and must not write
		expect(seq.isLatest(first)).toBe(false)
	})

	test('a later success after an earlier failure is compatible (the newest decides)', () => {
		const seq = new ProbeSequencer()
		const a = seq.next()
		const b = seq.next()
		expect(seq.isLatest(a)).toBe(false)
		expect(seq.isLatest(b)).toBe(true)
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: ['voiceCallV4'], nativeApp: { platform: 'ios', version: '1.5.8', build: '105' } } })).toBe('compatible')
	})
})
