/**
 * The native side of a UI unlock.
 *
 * Called after the page's own unlock succeeded.
 * - browser (not a shell): there is no native wallet; continue.
 * - shell, native not answered (no hello ack): hold (fail closed).
 * - shell answered without the passcode capability: continue (the current behaviour; the maintainers must confirm that a shell without
 * the capability has no native wallet, see the report).
 * - native status: `passcodeStatus` built by buildPasscodeCommand (reqId and eoa). Unlocked ONLY when the reply carries
 * `nativeLocked === false` (NL-1, NL-7). `true`, missing, non-boolean, an error reply or a timeout are locked (NL-2..NL-6).
 * `walletState` (present = the wallet exists) and `locked` (the device passcode lock) never decide it.
 * unlocked → nativeIdentityCheck {eoa}: {ok:true,match:true} continue; {ok:true,match:false} mismatch (the account-conflict
 * flow, path not yet located: the caller stops this account's operations and uses no other copy);
 * {ok:false,error:"locked"} → passcodeUnlock; any other reply (bad_request, unknown) → hold.
 * locked → passcodeUnlock {eoa, passcode}. Its success continues; any failure holds.
 * - a command that cannot be built (no eoa, bad reqId) holds: no status can be read, so nothing is decided.
 *
 * `hold` keeps the lock on screen. A failed or unknown answer is never a continue.
 */
import { buildPasscodeCommand, passcodeCapabilityDeclared } from './passcodeCommands'
import { buildNativeIdentityCheck, decideNativeIdentityCheck } from './nativeIdentityCheck'
import { shellPasscodeReqIdFor } from '../reqIdSpaces'

export type NativeAfterUnlock = 'continue' | 'mismatch' | 'hold'

export type UiUnlockNativeDeps = {
	/** The shell's declared capabilities (hello ack). `answered:false` means no declaration. */
	probe: () => Promise<{ answered: boolean; capabilities: readonly string[] }>
	/** Sends one command and returns the reply payload (the shell's ack), or null when there is no reply. */
	send: (cmd: Record<string, unknown>) => Promise<unknown>
}

/** The reqId for a passcode command: the page's passcode range. A counter past the range throws there; the caller holds. */
let reqCounter = 0
const nextReqId = (): number => {
	reqCounter += 1
	return shellPasscodeReqIdFor(reqCounter)
}

/**
 * Unlocked only for the ack envelope `{type:'ack', ok:true, result:{nativeLocked:false}}`. Any other shape (a bare body, a
 * missing or false ok, an error, a non-object result) is locked (fail closed). Vector shapes are adapted in the tests, not here.
 */
export function nativeUnlockedFromStatusReply(payload: unknown): boolean {
	if (!payload || typeof payload !== 'object') return false
	const p = payload as { type?: unknown; ok?: unknown; result?: unknown }
	if (p.type !== 'ack' || p.ok !== true) return false
	if (!p.result || typeof p.result !== 'object') return false
	return (p.result as { nativeLocked?: unknown }).nativeLocked === false
}

/**
 * A shell reply normalised to {ok, match, error}. Anything not shaped as an ack is ok:false (fail closed).
 * Known ack shape (the same reading as passcodeStatus and accountCleanupOld): {type:'ack', ok, result?:{match?, error?, ok?}}.
 * When the ack carries ok:true and no result.ok, ok is read as true. The final shape is confirmed with the shells' real replies.
 */
export function normalizeNativeReply(payload: unknown): { ok?: unknown; match?: unknown; error?: unknown } {
	if (!payload || typeof payload !== 'object') return { ok: false, error: 'no_reply' }
	const p = payload as { type?: unknown; ok?: unknown; error?: unknown; result?: unknown; match?: unknown }
	if (p.type !== 'ack') return { ok: false, error: 'not_ack' }
	const body = p.result && typeof p.result === 'object' ? (p.result as { match?: unknown; error?: unknown; ok?: unknown }) : {}
	return {
		ok: p.ok === true ? (body.ok === undefined ? true : body.ok) : false,
		match: body.match !== undefined ? body.match : p.match,
		error: body.error !== undefined ? body.error : p.error,
	}
}

async function passcodeUnlockPath(eoa: string, passcode: string, deps: UiUnlockNativeDeps): Promise<NativeAfterUnlock> {
	const built = buildPasscodeCommand('passcodeUnlock', { reqId: nextReqId(), eoa, passcode })
	if (!built.ok) return 'hold'
	const reply = normalizeNativeReply(await deps.send(built.command))
	return reply.ok === true ? 'continue' : 'hold'
}

export async function afterUiUnlock(
	args: { shell: boolean; eoa: string | null; passcode: string },
	deps: UiUnlockNativeDeps,
): Promise<NativeAfterUnlock> {
	// Browser: there is no native wallet to check.
	if (!args.shell) return 'continue'
	const probe = await deps.probe()
	// Shell that could not be asked: fail closed.
	if (!probe.answered) return 'hold'
	// Shell without the passcode capability: the current behaviour.
	if (!passcodeCapabilityDeclared([...probe.capabilities])) return 'continue'
	if (!args.eoa) return 'hold'
	const status = buildPasscodeCommand('passcodeStatus', { reqId: nextReqId(), eoa: args.eoa })
	if (!status.ok) return 'hold'
	const unlocked = nativeUnlockedFromStatusReply(await deps.send(status.command))
	if (!unlocked) return passcodeUnlockPath(args.eoa, args.passcode, deps)
	const built = buildNativeIdentityCheck(args.eoa, nextReqId())
	if (!built.ok) return 'hold'
	const verdict = decideNativeIdentityCheck(normalizeNativeReply(await deps.send(built.command)))
	if (verdict === 'continue') return 'continue'
	if (verdict === 'account_conflict') return 'mismatch'
	if (verdict === 'normal_unlock') return passcodeUnlockPath(args.eoa, args.passcode, deps)
	return 'hold'
}
