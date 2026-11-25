/**
 * 0.53.50: the page side of onboarding create in a shell (plan r3-create). The create page is the PWA page; the page collects the BeamioTag and
 * the password and hands them to the native layer through shell actions, never through the chat-module channel:
 *
 *   nativeAccountCreateOpen(tag)  (existing command; headless host)  ->  accountCreateRegister {tag, password}  ->  POST /api/addUser
 *
 * `accountCreateRegister` and `secureScreen` use the same trusted adapter as nativeRecoverySubmit: Android window.BeamioShell (WebMessage),
 * iOS window.CashTreesIOS plus the `cashtreesios` answer. Both need the top frame of a trusted origin and the capability
 * `account.page-create.v1`; without it nothing is sent. Nothing here logs or keeps an input or an answer.
 */
import { hasBeamioShell, requestBeamioShell } from '@/utils/beamioShellChannel'
import { iosShellAction, isIosShell, isTrustedRecoveryOrigin, shellCapabilityDeclared } from './nativeRecovery'

export const PAGE_CREATE_CAPABILITY = 'account.page-create.v1'
const REGISTER_TIMEOUT_MS = 120_000
const SECURE_SCREEN_TIMEOUT_MS = 10_000

/** The shell declared that the page may create the account (`account.page-create.v1`). */
export async function hasPageCreate(): Promise<boolean> {
	return shellCapabilityDeclared(PAGE_CREATE_CAPABILITY)
}

/** Shell answers that are not a registration answer: the transport, the origin or the capability failed (the page treats them as unavailable). */
const TRANSPORT_FAILURES = new Set(['timeout', 'origin_refused', 'capability_missing', 'native_unavailable', 'bridge_missing', 'not_supported', 'unknown_command', 'bad_args'])

/**
 * Sends accountCreateRegister {tag, password} and answers the envelope the register parser reads ({type:'ack', ok, reqId, result|error}), or
 * null when nothing usable came back (no capability, untrusted origin, no channel, refused, timeout). The SDK's own error codes pass through.
 */
export async function sendAccountCreateRegister(cmd: { reqId: number; tag: string; password: string }): Promise<unknown | null> {
	if (!isTrustedRecoveryOrigin()) return null
	if (!(await hasPageCreate())) return null
	const args = { tag: cmd.tag, password: cmd.password }
	let out: { ok: true; result?: unknown } | { ok: false; reason: string }
	if (isIosShell()) {
		out = await iosShellAction('accountCreateRegister', args, REGISTER_TIMEOUT_MS)
	} else {
		if (!hasBeamioShell()) return null
		const ack = await requestBeamioShell('accountCreateRegister', args, REGISTER_TIMEOUT_MS)
		out = ack.ok ? { ok: true, result: ack.result } : { ok: false, reason: ack.error }
	}
	if (out.ok) return { type: 'ack', ok: true, reqId: cmd.reqId, result: out.result }
	if (TRANSPORT_FAILURES.has(out.reason)) return null
	return { type: 'ack', ok: false, reqId: cmd.reqId, error: out.reason }
}

/** The shell keeps the screen protected (Android FLAG_SECURE, iOS app-switcher cover) while the recover code shows. Never throws; false = not applied. */
export async function setSecureScreen(on: boolean): Promise<boolean> {
	if (!isTrustedRecoveryOrigin()) return false
	try {
		if (isIosShell()) return (await iosShellAction('secureScreen', { on }, SECURE_SCREEN_TIMEOUT_MS)).ok
		if (!hasBeamioShell()) return false
		return (await requestBeamioShell('secureScreen', { on }, SECURE_SCREEN_TIMEOUT_MS)).ok
	} catch {
		return false
	}
}
