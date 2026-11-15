/**
 * Mailbox online probe signature in a shell (interface;  is replaced by GM).
 *
 * The page sends `mailboxProbeSign` with the probe kind and the target only. The native layer builds the message and signs it with the
 * session account. The page uses the returned `message` as it is, and never builds or signs it itself in a shell (no page key).
 * The command is used only when the hello answer declares `mailbox.probe.sign.v1`. Without that capability the probe is
 * `not_supported`: there is no fallback to a page signature.
 *
 * Request and answer shapes: the flat envelope of  (interface ): the request {type, reqId, command, targetWallet, timestamp},
 * the answer {type: "ack", reqId, ok, result: {message, signature}}. The vector file mailbox-probe-sign-vectors.v1.json still shows an
 * {action, args} envelope; the spec governs until the vectors are regenerated.
 * SYNTHETIC values only in this file.
 */
import { probeNativeCapabilities, requestNativeAck } from './nativeChatRouteRegister'

export const NATIVE_MAILBOX_PROBE_SIGN_COMMAND = 'mailboxProbeSign'
/** The hello capability that says the native layer implements the command. */
export const MAILBOX_PROBE_SIGN_CAPABILITY = 'mailbox.probe.sign.v1'
/** The two probe kinds. */
export type MailboxProbeCommand = 'wallet_online_query' | 'wallet_native_wake_query'

export type MailboxProbeSignOutcome = { ok: true; message: string; signature: string } | { ok: false; reason: string }

const SIGN_TIMEOUT_MS = 30_000
const SIG_RE = /^0x[0-9a-fA-F]{130}$/

/**
 * Asks the shell to build and sign one probe. Declared capability first: an undeclared shell answers `not_supported` and nothing is
 * sent beyond the hello. The answer's `message` and `signature` are checked for shape only; their content is the native layer's.
 */
export async function nativeMailboxProbeSign(args: {
	command: MailboxProbeCommand
	targetWallet: string
	timestamp: number
}): Promise<MailboxProbeSignOutcome> {
	const probe = await probeNativeCapabilities()
	if (!probe.answered) return { ok: false, reason: 'native_unavailable' }
	if (!probe.capabilities.includes(MAILBOX_PROBE_SIGN_CAPABILITY)) return { ok: false, reason: 'not_supported' }
	// Flat envelope (GT): dispatched by `type`, like the other chat commands. Not {action, args}.
	const answer = await requestNativeAck(
		{ type: NATIVE_MAILBOX_PROBE_SIGN_COMMAND, command: args.command, targetWallet: args.targetWallet, timestamp: args.timestamp },
		SIGN_TIMEOUT_MS,
	)
	if (answer.kind !== 'payload') return { ok: false, reason: answer.kind }
	const p = answer.payload as { type?: unknown; ok?: unknown; error?: unknown; result?: unknown }
	if (p.type === 'ack' && p.ok === true) {
		const r = (p.result && typeof p.result === 'object' ? p.result : {}) as { message?: unknown; signature?: unknown }
		if (typeof r.message === 'string' && r.message.length > 0 && typeof r.signature === 'string' && SIG_RE.test(r.signature)) {
			return { ok: true, message: r.message, signature: r.signature }
		}
		return { ok: false, reason: 'bad_ack' }
	}
	return { ok: false, reason: typeof p.error === 'string' && p.error ? p.error : 'bad_ack' }
}
