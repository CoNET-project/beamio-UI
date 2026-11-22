/**
 * @jest-environment node
 *
 * plan A, PWA side. The three commands carry only `{type, reqId, accountKey}` (plus the
 * idempotency key for create). Answers and events are read by their codes; no key, armor, passphrase or backup is sent or read.
 * SYNTHETIC values only.
 */
import { grantPgpCreateEligibility } from './pgpIdentityEligibility'
import {
	evaluateNativePgpRestore,
	nativeGenerateNewPgpKey,
	PGP_IDENTITY_CREATE_ENABLED,
	sendNativePgpIdentityCreate,
	newIdempotencyKey,
	NATIVE_PGP_CREATE_COMMAND,
	NATIVE_PGP_EVALUATE_COMMAND,
	NATIVE_PGP_RESTORE_COMMAND,
	parsePgpEvaluateResult,
	restoreNativePgp,
} from './nativePgpRestore'
import { NATIVE_QUERY_REQ_BASE, NATIVE_QUERY_REQ_END } from './nativeKeyState'
import { NATIVE_KEYS_CAPABILITY } from './shellChatState'

const ACCOUNT = '0x9858effd232b4033e47d90003d41ec34ecaeda94:default'

type Sent = Record<string, unknown>
type Win = EventTarget & { CashTreesIOS?: unknown }
const w = new EventTarget() as Win
;(globalThis as unknown as { window: Win }).window = w
class ShellCustomEvent extends Event {
	readonly detail: unknown
	constructor(type: string, init?: { detail?: unknown }) {
		super(type)
		this.detail = init?.detail
	}
}
;(globalThis as unknown as { CustomEvent: typeof ShellCustomEvent }).CustomEvent = ShellCustomEvent

let sent: Sent[] = []

/** The reply for one command: an ack, then zero or more result events carrying the same reqId. */
type Reply = {
	ack: Record<string, unknown>
	events?: Array<{ type: string; code: string }>
}
let replyFor: (cmd: Sent) => Reply | null = () => null

function installShell(caps: string[]): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const send = (payload: Record<string, unknown>) =>
				setTimeout(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } })), 0)
			if (cmd.type === 'hello') {
				// the hello answer is an ack carrying ack.result.capabilities (the init ready event is not the hello answer)
				send({ type: 'ack', reqId: cmd.reqId, ok: true, result: { capabilities: caps } })
				return
			}
			const r = replyFor(cmd)
			if (!r) return
			send({ ...r.ack, reqId: cmd.reqId })
			for (const e of r.events ?? []) send({ type: e.type, reqId: cmd.reqId, code: e.code })
		},
	}
}

const sentOf = (type: string) => sent.filter((c) => c.type === type)

beforeEach(() => {
	sent = []
	replyFor = () => null
})
afterEach(() => {
	delete w.CashTreesIOS
})

describe('evaluate (pgpRestoreEvaluate): read-only', () => {
	it('sends only type, reqId and accountKey; an ok evaluation is a state, not a restore', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = (cmd) =>
			cmd.type === NATIVE_PGP_EVALUATE_COMMAND
				? { ack: { type: 'ack', ok: true, result: { state: 'ok', failureClass: null, code: 'ok', offerEntry: false } } }
				: null
		await expect(evaluateNativePgpRestore(ACCOUNT)).resolves.toEqual({ kind: 'evaluated', state: 'ok', failureCode: null, offerEntry: false, legacy: 'unknown', chain: 'unknown' })
		const cmd = sentOf(NATIVE_PGP_EVALUATE_COMMAND)[0]
		expect(Object.keys(cmd).sort()).toEqual(['accountKey', 'reqId', 'type'])
		expect(cmd.accountKey).toBe(ACCOUNT)
		expect(sentOf(NATIVE_PGP_RESTORE_COMMAND)).toHaveLength(0)
		expect(sentOf(NATIVE_PGP_CREATE_COMMAND)).toHaveLength(0)
	})

	it('a backup-missing failure maps to the page code and offers the entry', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = () => ({ ack: { type: 'ack', ok: true, result: { state: 'failed', failureClass: 'backup_missing', code: 'pgp_backup_missing', offerEntry: true } } })
		await expect(evaluateNativePgpRestore(ACCOUNT)).resolves.toEqual({
			kind: 'evaluated',
			state: 'failed',
			failureCode: 'pgp_backup_missing',
			offerEntry: true,
			legacy: 'unknown',
			chain: 'unknown',
		})
	})

	it('a registration-missing failure maps to pgp_registration_missing', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = () => ({ ack: { type: 'ack', ok: true, result: { state: 'failed', failureClass: 'registration_missing', offerEntry: true } } })
		const r = await evaluateNativePgpRestore(ACCOUNT)
		expect(r).toMatchObject({ kind: 'evaluated', failureCode: 'pgp_registration_missing' })
	})

	it('a refused ack is a refusal code, not a state; an unknown refusal is unknown_ack', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = () => ({ ack: { type: 'ack', ok: false, error: 'no_key' } })
		await expect(evaluateNativePgpRestore(ACCOUNT)).resolves.toEqual({ kind: 'refused', code: 'no_key' })
		replyFor = () => ({ ack: { type: 'ack', ok: false, error: 'something_new' } })
		await expect(evaluateNativePgpRestore(ACCOUNT)).resolves.toEqual({ kind: 'refused', code: 'unknown_ack' })
	})

	it('no shell channel: unavailable, and nothing is sent', async () => {
		await expect(evaluateNativePgpRestore(ACCOUNT)).resolves.toEqual({ kind: 'unavailable' })
		expect(sent).toHaveLength(0)
	})

	it('the command reqId is inside the gate-query range', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = () => ({ ack: { type: 'ack', ok: true, result: { state: 'ok' } } })
		await evaluateNativePgpRestore(ACCOUNT)
		const reqId = sentOf(NATIVE_PGP_EVALUATE_COMMAND)[0].reqId as number
		expect(reqId).toBeGreaterThanOrEqual(NATIVE_QUERY_REQ_BASE)
		expect(reqId).toBeLessThan(NATIVE_QUERY_REQ_END)
	})
})

describe('parsePgpEvaluateResult: only known values are accepted', () => {
	it('failed without a failure class, an unknown state, or an unknown class is unavailable', () => {
		expect(parsePgpEvaluateResult({ state: 'failed', failureClass: null })).toEqual({ kind: 'unavailable' })
		expect(parsePgpEvaluateResult({ state: 'maybe' })).toEqual({ kind: 'unavailable' })
		expect(parsePgpEvaluateResult({ state: 'failed', failureClass: 'whatever' })).toEqual({ kind: 'unavailable' })
		expect(parsePgpEvaluateResult(null)).toEqual({ kind: 'unavailable' })
	})

	it('first_identity and undetermined are states with no failure code', () => {
		expect(parsePgpEvaluateResult({ state: 'first_identity', failureClass: null, offerEntry: true })).toEqual({
			kind: 'evaluated',
			state: 'first_identity',
			failureCode: null,
			offerEntry: true,
			legacy: 'unknown',
			chain: 'unknown',
		})
		expect(parsePgpEvaluateResult({ state: 'undetermined' })).toMatchObject({ kind: 'evaluated', state: 'undetermined', failureCode: null })
	})
})

describe('restore (pgpRestore): waits for pgpRestoreResult', () => {
	it('an ok result is ok; the command carries only type, reqId and accountKey', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = (cmd) =>
			cmd.type === NATIVE_PGP_RESTORE_COMMAND
				? { ack: { type: 'ack', ok: true, result: { accepted: true } }, events: [{ type: 'pgpRestoreResult', code: 'ok' }] }
				: null
		await expect(restoreNativePgp(ACCOUNT)).resolves.toEqual({ ok: true })
		const cmd = sentOf(NATIVE_PGP_RESTORE_COMMAND)[0]
		expect(Object.keys(cmd).sort()).toEqual(['accountKey', 'reqId', 'type'])
	})

	it('a fingerprint mismatch maps to its page code; a decrypt failure maps to undecryptable', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = () => ({ ack: { type: 'ack', ok: true, result: { accepted: true } }, events: [{ type: 'pgpRestoreResult', code: 'pgp_fingerprint_mismatch' }] })
		await expect(restoreNativePgp(ACCOUNT)).resolves.toEqual({ ok: false, code: 'pgp_fingerprint_mismatch', failure: 'pgp_fingerprint_mismatch' })
		replyFor = () => ({ ack: { type: 'ack', ok: true, result: { accepted: true } }, events: [{ type: 'pgpRestoreResult', code: 'pgp_backup_invalid' }] })
		await expect(restoreNativePgp(ACCOUNT)).resolves.toMatchObject({ ok: false, failure: 'pgp_backup_undecryptable' })
	})

	it('a result code that is not a shown failure is returned with failure null (retried, not shown)', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = () => ({ ack: { type: 'ack', ok: true, result: { accepted: true } }, events: [{ type: 'pgpRestoreResult', code: 'readback_failed' }] })
		await expect(restoreNativePgp(ACCOUNT)).resolves.toEqual({ ok: false, code: 'readback_failed', failure: null })
	})

	it('a refused ack (already_exists) is returned at once and nothing is waited for', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = () => ({ ack: { type: 'ack', ok: false, error: 'already_exists' } })
		await expect(restoreNativePgp(ACCOUNT)).resolves.toEqual({ ok: false, code: 'already_exists', failure: null })
		expect(sentOf(NATIVE_PGP_RESTORE_COMMAND)).toHaveLength(1)
	})
})

describe('create (pgpIdentityCreate): the user click only', () => {
	it('sends only type, reqId, accountKey and idempotencyKey; ok with a mode', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = (cmd) =>
			cmd.type === NATIVE_PGP_CREATE_COMMAND
				? { ack: { type: 'ack', ok: true, result: { accepted: true, mode: 'replace' } }, events: [{ type: 'pgpIdentityCreateResult', code: 'ok' }] }
				: null
		await expect(sendNativePgpIdentityCreate(ACCOUNT, 'idem-0001')).resolves.toEqual({ ok: true, mode: 'replace' })
		const cmd = sentOf(NATIVE_PGP_CREATE_COMMAND)[0]
		expect(Object.keys(cmd).sort()).toEqual(['accountKey', 'idempotencyKey', 'reqId', 'type'])
		expect(cmd.idempotencyKey).toBe('idem-0001')
	})

	it('a repeat with the same key is idempotent and counts as done', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = () => ({ ack: { type: 'ack', ok: true, result: { accepted: true } }, events: [{ type: 'pgpIdentityCreateResult', code: 'idempotent' }] })
		await expect(sendNativePgpIdentityCreate(ACCOUNT, 'idem-0001')).resolves.toMatchObject({ ok: true })
	})

	it('a cancelled confirmation is returned as its code', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = () => ({ ack: { type: 'ack', ok: true, result: { accepted: true, mode: 'first' } }, events: [{ type: 'pgpIdentityCreateResult', code: 'cancelled' }] })
		await expect(sendNativePgpIdentityCreate(ACCOUNT, 'idem-0002')).resolves.toEqual({ ok: false, reason: 'cancelled' })
	})

	it('pending_exists is refused at the ack and nothing is waited for', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = () => ({ ack: { type: 'ack', ok: false, error: 'pending_exists' } })
		await expect(sendNativePgpIdentityCreate(ACCOUNT, 'idem-0003')).resolves.toEqual({ ok: false, reason: 'pending_exists' })
	})

	it('waiting_registration is refused at the ack (1): the code is kept, the sender does not wait for a result', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = () => ({ ack: { type: 'ack', ok: false, error: 'waiting_registration' } })
		await expect(sendNativePgpIdentityCreate(ACCOUNT, 'idem-0006')).resolves.toEqual({ ok: false, reason: 'waiting_registration' })
		expect(sentOf(NATIVE_PGP_CREATE_COMMAND)).toHaveLength(1)
	})

	it('without the chat capability: native_unavailable, and no command is sent', async () => {
		installShell([])
		await expect(sendNativePgpIdentityCreate(ACCOUNT, 'idem-0004')).resolves.toEqual({ ok: false, reason: 'native_unavailable' })
		expect(sentOf(NATIVE_PGP_CREATE_COMMAND)).toHaveLength(0)
	})

	it('no account key: no_account, and no command is sent', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		await expect(sendNativePgpIdentityCreate('', 'idem-0005')).resolves.toEqual({ ok: false, reason: 'no_account' })
		expect(sent).toHaveLength(0)
	})

	it('each click gets its own idempotency key', () => {
		expect(newIdempotencyKey()).not.toBe(newIdempotencyKey())
	})
})

describe('pgpIdentityCreate is off until approval for the chain write', () => {
	it('the flag is false', () => {
		expect(PGP_IDENTITY_CREATE_ENABLED).toBe(false)
	})

	it('without the first-identity eligibility the click returns not_eligible and sends no command; with eligibility and the switch off, not_enabled', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		await expect(nativeGenerateNewPgpKey(ACCOUNT, 'idem-0006')).resolves.toEqual({ ok: false, reason: 'not_eligible' })
		grantPgpCreateEligibility(ACCOUNT)
		await expect(nativeGenerateNewPgpKey(ACCOUNT, 'idem-0006')).resolves.toEqual({ ok: false, reason: 'not_enabled' })
		expect(sent).toHaveLength(0)
	})
})

describe('the evaluate result is in the ack: result.code, no result event (-4)', () => {
	it('result.code pgp_source_unavailable is a temporary state, not a missing PGP', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = (cmd) => (cmd.type === NATIVE_PGP_EVALUATE_COMMAND ? { ack: { type: 'ack', ok: true, result: { state: 'undetermined', failureClass: null, code: 'pgp_source_unavailable', offerEntry: false } } } : null)
		await expect(evaluateNativePgpRestore(ACCOUNT)).resolves.toEqual({ kind: 'source_unavailable' })
	})

	it('a refused ack with error pgp_source_unavailable is the same temporary state', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = (cmd) => (cmd.type === NATIVE_PGP_EVALUATE_COMMAND ? { ack: { type: 'ack', ok: false, error: 'pgp_source_unavailable' } } : null)
		await expect(evaluateNativePgpRestore(ACCOUNT)).resolves.toEqual({ kind: 'source_unavailable' })
	})

	it('a top-level code without result.code is not read; the ack result without a state is unavailable', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = (cmd) => (cmd.type === NATIVE_PGP_EVALUATE_COMMAND ? { ack: { type: 'ack', ok: true, code: 'pgp_source_unavailable', result: { accepted: true } } } : null)
		await expect(evaluateNativePgpRestore(ACCOUNT)).resolves.toEqual({ kind: 'unavailable' })
	})

	// not_ready is unknown and retryable, never a refusal and never a missing key.
	it('not_ready as the ack error is the temporary source state (retried, no new PGP)', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = (cmd) => (cmd.type === NATIVE_PGP_EVALUATE_COMMAND ? { ack: { type: 'ack', ok: false, error: 'not_ready' } } : null)
		await expect(evaluateNativePgpRestore(ACCOUNT)).resolves.toEqual({ kind: 'source_unavailable' })
	})

	it('not_ready as result.code is the temporary source state', async () => {
		installShell([NATIVE_KEYS_CAPABILITY])
		replyFor = (cmd) => (cmd.type === NATIVE_PGP_EVALUATE_COMMAND ? { ack: { type: 'ack', ok: true, result: { state: 'undetermined', failureClass: null, code: 'not_ready', offerEntry: false } } } : null)
		await expect(evaluateNativePgpRestore(ACCOUNT)).resolves.toEqual({ kind: 'source_unavailable' })
	})
})
