import { PASSCODE_CAPABILITY } from './passcodeCommands'
import { afterUiUnlock, nativeUnlockedFromStatusReply, normalizeNativeReply, type UiUnlockNativeDeps } from './uiUnlockNative'

// Vectors: native-unlock-judgement-vectors.v1.json. Copied as data.
const EOA = '0x1111111111111111111111111111111111111111'
const P = '12345678'

/** Replies by command type: the status reply and the identity-check reply; a passcodeUnlock reply defaults to ok. */
const deps = (over: { probe?: UiUnlockNativeDeps['probe']; status?: unknown; identity?: unknown; unlock?: unknown } = {}) => {
	const sent: Record<string, unknown>[] = []
	const d: UiUnlockNativeDeps = {
		probe: over.probe ?? (async () => ({ answered: true, capabilities: [PASSCODE_CAPABILITY] })),
		send: async (cmd) => {
			sent.push(cmd)
			if (cmd.type === 'passcodeStatus') return over.status === undefined ? { type: 'ack', ok: true, result: { nativeLocked: true } } : over.status
			if (cmd.type === 'nativeIdentityCheck') return over.identity === undefined ? { type: 'ack', ok: true, result: { match: true } } : over.identity
			return over.unlock === undefined ? { type: 'ack', ok: true, result: {} } : over.unlock
		},
	}
	return { d, sent }
}

describe('afterUiUnlock gates', () => {
	test('browser: no native call, continue', async () => {
		const { d, sent } = deps()
		expect(await afterUiUnlock({ shell: false, eoa: EOA, passcode: P }, d)).toBe('continue')
		expect(sent).toEqual([])
	})
	test('shell not answered: hold, nothing sent', async () => {
		const { d, sent } = deps({ probe: async () => ({ answered: false, capabilities: [] }) })
		expect(await afterUiUnlock({ shell: true, eoa: EOA, passcode: P }, d)).toBe('hold')
		expect(sent).toEqual([])
	})
	test('shell without the capability: continue, nothing sent', async () => {
		const { d, sent } = deps({ probe: async () => ({ answered: true, capabilities: ['identity.native-keys.v1'] }) })
		expect(await afterUiUnlock({ shell: true, eoa: EOA, passcode: P }, d)).toBe('continue')
		expect(sent).toEqual([])
	})
	test('no eoa: hold', async () => {
		const { d, sent } = deps()
		expect(await afterUiUnlock({ shell: true, eoa: null, passcode: P }, d)).toBe('hold')
		expect(sent).toEqual([])
	})
})

describe('passcodeStatus request (built by buildPasscodeCommand: type, reqId, eoa)', () => {
	test('the status command carries a reqId and eoa and no passcode', async () => {
		const { d, sent } = deps({ status: { type: 'ack', ok: true, result: { nativeLocked: false } } })
		await afterUiUnlock({ shell: true, eoa: EOA, passcode: P }, d)
		expect(sent[0]).toMatchObject({ type: 'passcodeStatus', eoa: EOA })
		expect(typeof sent[0].reqId).toBe('number')
		expect(sent[0]).not.toHaveProperty('passcode')
	})
})

/** The vector shapes are a flat body; the envelope is the ack the shell sends. The adaptation lives here, in the test. */
const asAck = (body: Record<string, unknown>) => ({ type: 'ack', ok: true, result: body })

describe('native unlocked only by an ack with result.nativeLocked === false (NL-1..NL-7)', () => {
	test.each([
		['NL-1', { set: true, locked: 'device-level', hasKey: true, walletState: 'present', nativeLocked: false }, true],
		['NL-2', { set: true, locked: 'device-level', hasKey: true, walletState: 'present', nativeLocked: true }, false],
		['NL-3', { set: true, locked: 'device-level', hasKey: true, walletState: 'present' }, false],
		['NL-4', { set: true, locked: 'device-level', hasKey: true, walletState: 'present', nativeLocked: 'false' }, false],
		['NL-5', { set: true, locked: 'device-level', hasKey: true, walletState: 'present', nativeLocked: 0 }, false],
		['NL-7', { set: true, locked: 'device-level', hasKey: true, walletState: 'present', nativeLocked: false, walletState_is_present_only: true }, true],
	])('%s', (_id, body, expected) => {
		expect(nativeUnlockedFromStatusReply(asAck(body))).toBe(expected)
	})
	test('NL-6 error or timeout is locked', () => {
		expect(nativeUnlockedFromStatusReply({ error: 'timeout' })).toBe(false)
		expect(nativeUnlockedFromStatusReply({ type: 'ack', ok: false, error: 'timeout' })).toBe(false)
		expect(nativeUnlockedFromStatusReply(null)).toBe(false)
	})
	test('a bare body (no ack envelope) with nativeLocked:false is NOT unlocked (fail open refused)', () => {
		expect(nativeUnlockedFromStatusReply({ nativeLocked: false })).toBe(false)
		expect(nativeUnlockedFromStatusReply({ type: 'ack', result: { nativeLocked: false } })).toBe(false)
		expect(nativeUnlockedFromStatusReply({ type: 'ack', ok: false, result: { nativeLocked: false } })).toBe(false)
	})
	test('a status read as locked goes to passcodeUnlock', async () => {
		const { d, sent } = deps({ status: { error: 'timeout' } })
		expect(await afterUiUnlock({ shell: true, eoa: EOA, passcode: P }, d)).toBe('continue')
		expect(sent.map((c) => c.type)).toEqual(['passcodeStatus', 'passcodeUnlock'])
	})
	test('a bare nativeLocked:false status reply does not skip the identity check', async () => {
		const { d, sent } = deps({ status: { nativeLocked: false } })
		expect(await afterUiUnlock({ shell: true, eoa: EOA, passcode: P }, d)).toBe('continue')
		expect(sent.map((c) => c.type)).toEqual(['passcodeStatus', 'passcodeUnlock'])
	})
	test('walletState alone never unlocks', () => {
		expect(nativeUnlockedFromStatusReply(asAck({ walletState: 'present' }))).toBe(false)
	})
})

describe('nativeIdentityCheck replies (IC-1..IC-5)', () => {
	test('IC-1 unlocked, same mnemonic: continue', async () => {
		const { d, sent } = deps({ status: { type: 'ack', ok: true, result: { nativeLocked: false } }, identity: { type: 'ack', ok: true, result: { match: true } } })
		expect(await afterUiUnlock({ shell: true, eoa: EOA, passcode: P }, d)).toBe('continue')
		expect(sent.map((c) => c.type)).toEqual(['passcodeStatus', 'nativeIdentityCheck'])
	})
	test('IC-2 unlocked, different mnemonic: mismatch, no passcodeUnlock', async () => {
		const { d, sent } = deps({ status: { type: 'ack', ok: true, result: { nativeLocked: false } }, identity: { type: 'ack', ok: true, result: { match: false } } })
		expect(await afterUiUnlock({ shell: true, eoa: EOA, passcode: P }, d)).toBe('mismatch')
		expect(sent.map((c) => c.type)).not.toContain('passcodeUnlock')
	})
	test('IC-3 locked: passcodeUnlock', async () => {
		const { d, sent } = deps({ status: { type: 'ack', ok: true, result: { nativeLocked: false } }, identity: { type: 'ack', ok: false, error: 'locked' } })
		expect(await afterUiUnlock({ shell: true, eoa: EOA, passcode: P }, d)).toBe('continue')
		expect(sent.map((c) => c.type)).toEqual(['passcodeStatus', 'nativeIdentityCheck', 'passcodeUnlock'])
	})
	test('IC-4 and IC-5 bad_request hold', async () => {
		for (const eoa of [null, 'not-an-address']) {
			const { d } = deps({ status: { type: 'ack', ok: true, result: { nativeLocked: false } }, identity: { type: 'ack', ok: false, error: 'bad_request' } })
			expect(await afterUiUnlock({ shell: true, eoa: eoa as string | null, passcode: P }, d)).toBe('hold')
		}
		const { d } = deps({ status: { type: 'ack', ok: true, result: { nativeLocked: false } }, identity: { type: 'ack', ok: false, error: 'bad_request' } })
		expect(await afterUiUnlock({ shell: true, eoa: EOA, passcode: P }, d)).toBe('hold')
	})
	test('not_ready is not an answer: hold', async () => {
		const { d } = deps({ status: { type: 'ack', ok: true, result: { nativeLocked: false } }, identity: { type: 'ack', ok: false, error: 'not_ready' } })
		expect(await afterUiUnlock({ shell: true, eoa: EOA, passcode: P }, d)).toBe('hold')
	})
})

describe('passcodeUnlock result', () => {
	test('a failed passcodeUnlock holds', async () => {
		const { d } = deps({ status: { error: 'timeout' }, unlock: { type: 'ack', ok: false, error: 'wrong_passcode' } })
		expect(await afterUiUnlock({ shell: true, eoa: EOA, passcode: P }, d)).toBe('hold')
	})
})

describe('normalizeNativeReply', () => {
	test('reads match and error from the result, ok from the ack', () => {
		expect(normalizeNativeReply({ type: 'ack', ok: true, result: { match: true } })).toEqual({ ok: true, match: true, error: undefined })
		expect(normalizeNativeReply({ type: 'ack', ok: false, error: 'locked' })).toEqual({ ok: false, match: undefined, error: 'locked' })
		expect(normalizeNativeReply(undefined)).toEqual({ ok: false, error: 'no_reply' })
	})
})
