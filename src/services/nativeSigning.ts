/**
 * Account message signatures in a native shell (matrix v2 and; to; matrix).
 *
 * In a shell the page sends the text to sign and gets the signature back; the native layer signs with its own key. No key
 * crosses the bridge, and nothing is sent unless the shell declares `identity.native-keys.v1` (option A: no page-key
 * fallback in a shell). In a browser the account key is the approved exception and is used on the page.
 *
 * Command names and shapes are provisional until the interface owner confirms them in the new spec:
 * - `gossipSign` { type, reqId, message } -> ack result.signature (kind `gossip`)
 * - `gossipSign` { type, reqId, kind, message, inboundGeneration } -> ack result.signature (envelope | group;)
 *   - `signMessage` { type, reqId, kind, message }           -> ack result.signature   (W5, kind selfAuth)
 */
import { ethers } from 'ethers'
import { NATIVE_KEYS_CAPABILITY } from './shellChatState'
import { probeNativeCapabilities, requestNativeAck } from './nativeChatRouteRegister'
import { isShellContext } from './shellContext'
import { INBOUND_GENERATION_CAPABILITY, latestInboundGeneration } from './inboundGeneration'
import {
	GenerationRefusal,
	requestWithInboundGeneration,
	withInboundGeneration,
	type GenerationAttemptAnswer,
	type GenerationRequestDeps,
} from './inboundGenerationRequest'

export const NATIVE_GOSSIP_SIGN_COMMAND = 'gossipSign'
/** Kept for the record only: `signMessage` is not a bridge command. It is never sent. */
export const NATIVE_SIGN_MESSAGE_COMMAND = 'signMessage'
/** a message is at most 64 KiB of UTF-8. has its own, smaller bound. */
export const NATIVE_SIGN_MESSAGE_MAX_BYTES = 64 * 1024
export const NATIVE_GOSSIP_MAX_BYTES = 2048
const SIGN_TIMEOUT_MS = 30_000

/** The kinds the page may ask for. `gossip` is only for the delivery ack; `voice` and `ephemeral` are not here. */
export type NativeSignKind = 'envelope' | 'group' | 'selfAuth'

export type NativeSignOutcome = { ok: true; signature: string } | { ok: false; reason: string }

const SIG_RE = /^0x[0-9a-fA-F]{130}$/
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength

/** True when the text is a JSON object whose `command` is `gossip_delivery_ack`. */
export function isGossipAckShape(message: string): boolean {
	try {
		const v = JSON.parse(message) as unknown
		return !!v && typeof v === 'object' && !Array.isArray(v) && (v as { command?: unknown }).command === 'gossip_delivery_ack'
	} catch {
		return false
	}
}

/** One command to the native layer, after the capability check. Returns the ack's `result` or a short reason. */
async function sendNativeCommand(cmd: Record<string, unknown>): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; reason: string }> {
	const probe = await probeNativeCapabilities()
	if (!probe.answered || !probe.capabilities.includes(NATIVE_KEYS_CAPABILITY)) return { ok: false, reason: 'native_unavailable' }
	const answer = await requestNativeAck(cmd, SIGN_TIMEOUT_MS)
	if (answer.kind !== 'payload') return { ok: false, reason: answer.kind }
	const p = answer.payload as { type?: unknown; ok?: unknown; error?: unknown; result?: unknown }
	if (p.type === 'ack' && p.ok === true) {
		return { ok: true, result: p.result && typeof p.result === 'object' ? (p.result as Record<string, unknown>) : {} }
	}
	return { ok: false, reason: typeof p.error === 'string' && p.error ? p.error : 'bad_ack' }
}

async function sendSignCommand(cmd: Record<string, unknown>): Promise<NativeSignOutcome> {
	const out = await sendNativeCommand(cmd)
	if (!out.ok) return out
	const sig = out.result.signature
	return typeof sig === 'string' && SIG_RE.test(sig) ? { ok: true, signature: sig } : { ok: false, reason: 'bad_ack' }
}

/** the delivery ack. The native layer checks the shape and signs the exact text (no prefix, no re-serialising). */
export async function nativeSignGossip(message: string): Promise<NativeSignOutcome> {
	if (!message || utf8Bytes(message) > NATIVE_GOSSIP_MAX_BYTES) return { ok: false, reason: 'bad_request' }
	if (!isGossipAckShape(message)) return { ok: false, reason: 'not_gossip_shape' }
	return sendSignCommand({ type: NATIVE_GOSSIP_SIGN_COMMAND, message })
}

/**
 * W5 `signMessage`, for `selfAuth` only. A `gossip_delivery_ack` text is refused whatever the kind: it must go
 * through `nativeSignGossip`, so an envelope signature can never be replayed as an ack. `envelope` and `group` must carry the
 * inbound generation, so they go through `nativeSignWithGeneration`.
 */
export async function nativeSignMessage(kind: NativeSignKind, message: string): Promise<NativeSignOutcome> {
	if (kind !== 'envelope' && kind !== 'group' && kind !== 'selfAuth') return { ok: false, reason: 'kind_not_allowed' }
	if (!message || utf8Bytes(message) > NATIVE_SIGN_MESSAGE_MAX_BYTES) return { ok: false, reason: 'bad_request' }
	if (isGossipAckShape(message)) return { ok: false, reason: 'ack_requires_gossip_kind' }
	// selfAuth is a wallet-layer function, not a bridge command: the command table has no signMessage, and the
	// signing commands that exist (gossipSign) accept only gossip, envelope and group. A shell refuses selfAuth locally; nothing is sent.
	if (kind === 'selfAuth') return { ok: false, reason: 'not_supported' }
	return { ok: false, reason: 'generation_required' }
}

/** The answer of one generation-tagged send, and the deps of the request (see inboundGenerationRequest.ts). */
export type GenerationSendAnswer = GenerationAttemptAnswer
export type GenerationSignDeps = GenerationRequestDeps

/**
 * The production deps. The capabilities are read once per request (one hello probe). An older shell, which does not declare
 * `inbound.generation.v1`, gets no field and one attempt.
 */
const productionGenerationDeps = async (): Promise<GenerationSignDeps> => {
	const probe = await probeNativeCapabilities()
	const ready = probe.answered && probe.capabilities.includes(NATIVE_KEYS_CAPABILITY)
	const declared = probe.answered && probe.capabilities.includes(INBOUND_GENERATION_CAPABILITY)
	return {
		generation: latestInboundGeneration,
		declared: async () => declared,
		// An older shell (no capability) keeps the wait it had before the generation rules (30 s).
		legacyTimeoutMs: SIGN_TIMEOUT_MS,
		send: async (cmd, timeoutMs) => {
			if (!ready) return { kind: 'unavailable' }
			const answer = await requestNativeAck(cmd, timeoutMs)
			if (answer.kind === 'timeout') return { kind: 'timeout' }
			if (answer.kind !== 'payload') return { kind: 'unavailable' }
			const p = answer.payload as { type?: unknown; ok?: unknown; error?: unknown; result?: unknown }
			if (p.type === 'ack' && p.ok === true) {
				return { kind: 'ack', ok: true, result: p.result && typeof p.result === 'object' ? (p.result as Record<string, unknown>) : {} }
			}
			return { kind: 'ack', ok: false, reason: typeof p.error === 'string' && p.error ? p.error : 'bad_ack' }
		},
	}
}

/**
 * an envelope or group signature in a shell. The request carries `inboundGeneration` at its top level, the value
 * the page held when the request started. The wait, the drop rule and the resend rule are in inboundGenerationRequest.ts.
 */
export async function nativeSignWithGeneration(
	kind: 'envelope' | 'group',
	build: () => string,
	deps?: GenerationSignDeps,
): Promise<NativeSignOutcome> {
	if (kind !== 'envelope' && kind !== 'group') return { ok: false, reason: 'kind_not_allowed' }
	const useDeps = deps ?? (await productionGenerationDeps())
	const out = await requestWithInboundGeneration((generation) => {
		const message = build()
		if (!message || utf8Bytes(message) > NATIVE_SIGN_MESSAGE_MAX_BYTES) throw new GenerationRefusal('bad_request')
		if (isGossipAckShape(message)) throw new GenerationRefusal('ack_requires_gossip_kind')
		return withInboundGeneration({ type: NATIVE_GOSSIP_SIGN_COMMAND, kind, message }, generation)
	}, useDeps)
	if (!out.ok) return out
	const sig = (out.result as { signature?: unknown } | null)?.signature
	return typeof sig === 'string' && SIG_RE.test(sig) ? { ok: true, signature: sig } : { ok: false, reason: 'bad_ack' }
}

/**
 * The account's EIP-191 signature of `message`, for a chat envelope or a mailbox command. A shell asks the native layer and
 * throws its reason on refusal. A browser signs with the page's account key (the approved exception).
 */
export async function signAccountMessageFor(input: {
	kind: NativeSignKind
	message: string
	privateKeyArmor?: string
}): Promise<string> {
	if (isShellContext()) {
		const out =
			input.kind === 'selfAuth'
				? await nativeSignMessage(input.kind, input.message)
				: await nativeSignWithGeneration(input.kind, () => input.message)
		if (!out.ok) throw new Error(out.reason)
		return out.signature
	}
	const key = (input.privateKeyArmor || '').trim()
	if (!key) throw new Error('no_account_key')
	const wallet = new ethers.Wallet(key)
	return wallet.signMessage(input.message)
}

/** `accountSealPayload`: the native layer seals `plaintext` with the account (the key does not leave the native layer). */
export const NATIVE_ACCOUNT_SEAL_COMMAND = 'accountSealPayload'
export const NATIVE_ACCOUNT_SEAL_MAX_BYTES = 64 * 1024

export async function nativeSealAccountPayload(purposeId: string, plaintext: string): Promise<{ ok: true; ciphertext: string } | { ok: false; reason: string }> {
	if (!purposeId || !plaintext || utf8Bytes(plaintext) > NATIVE_ACCOUNT_SEAL_MAX_BYTES) return { ok: false, reason: 'bad_request' }
	const out = await sendNativeCommand({ type: NATIVE_ACCOUNT_SEAL_COMMAND, purposeId, plaintext })
	if (!out.ok) return out
	const c = out.result.ciphertext
	return typeof c === 'string' && c.length > 0 ? { ok: true, ciphertext: c } : { ok: false, reason: 'bad_ack' }
}

/**
 * The shell's sealed text for a purpose, or '' when the native layer refuses (the caller shows its own error). Only a shell
 * calls this; a browser keeps its own sealing on the page.
 */
export async function nativeSealOrEmpty(purposeId: string, plaintext: string): Promise<string> {
	const out = await nativeSealAccountPayload(purposeId, plaintext)
	return out.ok ? out.ciphertext : ''
}

/**
 * `walletBackupView`: the native layer shows the private key, the mnemonic or the recovery code itself, after its own
 * password step. Nothing comes back to the page (no result field). A browser keeps its page views, as before.
 */
export const NATIVE_BACKUP_VIEW_COMMAND = 'walletBackupView'
export type BackupViewKind = 'privateKey' | 'mnemonic' | 'recoveryCode'

export async function nativeWalletBackupView(kind: BackupViewKind): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (kind !== 'privateKey' && kind !== 'mnemonic' && kind !== 'recoveryCode') return { ok: false, reason: 'kind_not_allowed' }
	const out = await sendNativeCommand({ type: NATIVE_BACKUP_VIEW_COMMAND, kind })
	return out.ok ? { ok: true } : out
}
