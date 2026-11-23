import {
	callAllowed,
	callCapabilityStateOf,
	callUpgradePromptKey,
	normalizeCapabilities,
	settleHello,
	shapeOfHello,
	VOICE_CALL_V4_CAPABILITY,
} from './callCapability'

const V4 = VOICE_CALL_V4_CAPABILITY
const NATIVE = { platform: 'ios', version: '1.5.8', build: '105' }
const OK = { answered: true, capabilities: [V4], nativeApp: NATIVE } as const

describe('the capability name', () => {
	test('is voiceCallV4 (v139 §159)', () => {
		expect(V4).toBe('voiceCallV4')
	})
})

describe('the final rule (the decision; v154 §174): only a valid hello with voiceCallV4 is allowed', () => {
	test('browser: its own flow, no prompt, calls allowed', () => {
		const s = callCapabilityStateOf({ inShell: false, probe: 'failed' })
		expect(s).toBe('browser')
		expect(callAllowed(s)).toBe(true)
		expect(callUpgradePromptKey(s, 'chat')).toBeNull()
		expect(callUpgradePromptKey(s, 'incoming')).toBeNull()
	})

	test('loading: no prompt, no call (fail closed until the hello settles)', () => {
		const s = callCapabilityStateOf({ inShell: true, probe: 'pending' })
		expect(s).toBe('loading')
		expect(callAllowed(s)).toBe(false)
		expect(callUpgradePromptKey(s, 'chat')).toBeNull()
	})

	test('compatible: a valid hello with voiceCallV4, no prompt, calls allowed', () => {
		const s = callCapabilityStateOf({ inShell: true, probe: OK })
		expect(s).toBe('compatible')
		expect(callAllowed(s)).toBe(true)
		expect(callUpgradePromptKey(s, 'chat')).toBeNull()
		expect(callUpgradePromptKey(s, 'incoming')).toBeNull()
	})

	test('a valid hello without voiceCallV4, or capabilities missing: old_shell with the update prompt, no call', () => {
		for (const probe of [{ answered: true, capabilities: ['identity.native-keys.v1'] }, { answered: true, capabilities: undefined }] as const) {
			const s = callCapabilityStateOf({ inShell: true, probe: probe as never })
			expect(s).toBe('old_shell')
			expect(callAllowed(s)).toBe(false)
			expect(callUpgradePromptKey(s, 'chat')).toBe('call.upgrade.chat')
			expect(callUpgradePromptKey(s, 'incoming')).toBe('call.upgrade.incoming')
		}
	})

	test('a timeout, a refusal, an unanswered hello, a malformed answer or an unreadable result: old_shell with the prompt, no call', async () => {
		jest.useFakeTimers()
		const timedOut = settleHello(new Promise<never>(() => undefined) as never, 10_000)
		jest.advanceTimersByTime(10_000)
		const timeout = await timedOut
		jest.useRealTimers()
		const refused = await settleHello(Promise.reject(new Error('refused')), 10_000)
		const malformed = await settleHello(Promise.resolve('x'), 10_000)
		const unanswered = { answered: false, capabilities: [] as string[] }
		for (const probe of [timeout, refused, malformed, unanswered]) {
			const s = callCapabilityStateOf({ inShell: true, probe })
			expect(s).toBe('old_shell')
			expect(callAllowed(s)).toBe(false)
			expect(callUpgradePromptKey(s, 'chat')).toBe('call.upgrade.chat')
			expect(callUpgradePromptKey(s, 'incoming')).toBe('call.upgrade.incoming')
		}
	})

	test('compatible then failed: the latest result decides, so the later failure is old_shell (no cached compatible)', () => {
		const first = callCapabilityStateOf({ inShell: true, probe: OK })
		expect(first).toBe('compatible')
		const later = callCapabilityStateOf({ inShell: true, probe: 'failed' })
		expect(later).toBe('old_shell')
		expect(callAllowed(later)).toBe(false)
		expect(callUpgradePromptKey(later, 'chat')).toBe('call.upgrade.chat')
	})

	test('compatible then a valid hello without voiceCallV4: old_shell', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: [] } })).toBe('old_shell')
	})

	test('the prompt keys are only the two update prompts; none for the other states', () => {
		for (const s of ['browser', 'loading', 'compatible'] as const) {
			expect(callUpgradePromptKey(s, 'chat')).toBeNull()
			expect(callUpgradePromptKey(s, 'incoming')).toBeNull()
		}
	})
})

describe('settling and shape (a malformed answer is failed at the parse)', () => {
	test('a valid answer before the timeout is kept', async () => {
		const probe = await settleHello(Promise.resolve(OK), 10_000)
		expect(callCapabilityStateOf({ inShell: true, probe })).toBe('compatible')
	})

	test.each([
		['not an object', 'x'],
		['null', null],
		['array', []],
		['answered not boolean', { answered: 'yes', capabilities: [] }],
		['capabilities not an array', { answered: true, capabilities: 'voiceCallV4' }],
	])('a malformed answer (%s) parses to failed', (_n, raw) => {
		expect(shapeOfHello(raw)).toBe('failed')
	})

	test('normalise capabilities: null, undefined and non-strings drop out', () => {
		expect(normalizeCapabilities(null)).toEqual([])
		expect(normalizeCapabilities([V4, 42, '', null] as unknown[])).toEqual([V4])
	})
})

describe('the native app of the hello ack (the decision / ebecfe52; v156 §176): compatible needs a valid nativeApp and voiceCallV4', () => {
	test('valid nativeApp (ios or android, version and build in format) with voiceCallV4: compatible', () => {
		for (const nativeApp of [
			{ platform: 'ios', version: '1.5.8', build: '105' },
			{ platform: 'android', version: '1.0.165', build: '173' },
			{ platform: 'android', version: '1.2.3.4', build: '0' },
		]) {
			expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: [V4], nativeApp } })).toBe('compatible')
		}
	})

	test('voiceCallV4 without any nativeApp: old_shell', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: [V4] } })).toBe('old_shell')
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: [V4], nativeApp: null } })).toBe('old_shell')
	})

	test.each([
		['platform web', { platform: 'web', version: '1.5.8', build: '105' }],
		['version with a v prefix', { platform: 'ios', version: 'v1.5.8', build: '105' }],
		['version with five parts', { platform: 'ios', version: '1.2.3.4.5', build: '105' }],
		['version empty', { platform: 'ios', version: '', build: '105' }],
		['version with no dot (one part)', { platform: 'ios', version: '2', build: '1' }],
		['version a number', { platform: 'ios', version: 158, build: '105' }],
		['build not digits', { platform: 'ios', version: '1.5.8', build: '105a' }],
		['build empty', { platform: 'ios', version: '1.5.8', build: '' }],
		['build a number', { platform: 'ios', version: '1.5.8', build: 105 }],
		['not an object', 'ios 1.5.8'],
	])('an invalid nativeApp (%s) with voiceCallV4: old_shell', (_n, nativeApp) => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: [V4], nativeApp } })).toBe('old_shell')
	})

	test('a valid nativeApp without voiceCallV4: old_shell', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: ['identity.native-keys.v1'], nativeApp: NATIVE } })).toBe('old_shell')
	})

	test('the hello shape keeps nativeApp for the rule', async () => {
		const probe = await settleHello(Promise.resolve({ answered: true, capabilities: [V4], nativeApp: NATIVE }), 10_000)
		expect(callCapabilityStateOf({ inShell: true, probe })).toBe('compatible')
	})
})

/** v156 §176.4 format-level vectors (the positive values are illustrative, not a release declaration). */
describe('v156 §176.4 vectors', () => {
	const cap = [V4]
	test('positive 1: ios 1.5.8 build 105 → compatible', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: cap, nativeApp: { platform: 'ios', version: '1.5.8', build: '105' } } })).toBe('compatible')
	})
	test('positive 2: android 1.0.165 build 184 → compatible', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: cap, nativeApp: { platform: 'android', version: '1.0.165', build: '184' } } })).toBe('compatible')
	})
	test('negative 1: nativeApp missing → old_shell (even with voiceCallV4)', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: cap } })).toBe('old_shell')
	})
	test('negative 2: version empty → old_shell', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: cap, nativeApp: { platform: 'ios', version: '', build: '105' } } })).toBe('old_shell')
	})
	test('negative 3: version with five parts → old_shell', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: cap, nativeApp: { platform: 'ios', version: '1.5.8.1.2', build: '105' } } })).toBe('old_shell')
	})
	test('negative 4: version with a v prefix → old_shell', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: cap, nativeApp: { platform: 'ios', version: 'v1.5.8', build: '105' } } })).toBe('old_shell')
	})
	test('negative 5: build not digits → old_shell', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: cap, nativeApp: { platform: 'ios', version: '1.5.8', build: '10a' } } })).toBe('old_shell')
	})
	test('negative 6: platform web → old_shell', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: cap, nativeApp: { platform: 'web', version: '1.5.8', build: '105' } } })).toBe('old_shell')
	})
	test('the PWA or SDK version never stands in for nativeApp', () => {
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: cap, nativeApp: { platform: 'ios', version: '0.53.42', build: '1' } } })).toBe('compatible')
		expect(callCapabilityStateOf({ inShell: true, probe: { answered: true, capabilities: cap, nativeApp: { version: '0.53.42', build: '1' } } })).toBe('old_shell')
	})
})
