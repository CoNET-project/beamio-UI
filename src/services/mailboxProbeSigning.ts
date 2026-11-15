/**
 * The signature of a mailbox online probe. This is the decision the probe uses, with its
 * dependencies passed in, so the rule can be tested at run time without the chat service.
 *
 * - In a shell: the native layer builds the message and signs it (`mailboxProbeSign`). The page never signs and never builds the
 *   message there, so a shell with no page key still probes. A native refusal (or no declared capability) is null: no fallback.
 * - In a browser: the page signs the probe text with its own key (the ruled exception).
 * - Only the two probe commands are accepted, in either environment. Anything else is null and nothing is signed.
 */
import type { MailboxProbeCommand, MailboxProbeSignOutcome } from './nativeMailboxProbe'

/** The two probe kinds. */
export const MAILBOX_PROBE_COMMANDS: readonly MailboxProbeCommand[] = ['wallet_online_query', 'wallet_native_wake_query']

export interface SignedMailboxProbe {
	message: string
	signMessage: string
}

export interface MailboxProbeSigningDeps {
	/** True inside a native shell (no page key there). */
	isShell: () => boolean
	/** The shell command (see nativeMailboxProbe.ts). */
	nativeProbeSign: (args: { command: MailboxProbeCommand; targetWallet: string; timestamp: number }) => Promise<MailboxProbeSignOutcome>
	/** The browser's account address from its own key (EIP-55 or as the key gives it). */
	accountEoaFor: (privateKeyArmor: string) => string
	/** The browser's signature of the probe text with its own key. */
	pageSign: (message: string, privateKeyArmor: string) => Promise<string>
	/** EIP-55 checksum of an address; throws for an address that is not one. */
	checksumAddress: (address: string) => string
	/** Unix seconds. */
	nowSeconds: () => number
}

/** The signed probe, or null when it cannot be made (the caller stops the probe). */
export async function signMailboxProbe(
	command: MailboxProbeCommand,
	targetWallet: string,
	privateKeyArmor: string,
	deps: MailboxProbeSigningDeps,
): Promise<SignedMailboxProbe | null> {
	if (!MAILBOX_PROBE_COMMANDS.includes(command)) return null
	const target = deps.checksumAddress(targetWallet)
	const timestamp = deps.nowSeconds()
	if (deps.isShell()) {
		const out = await deps.nativeProbeSign({ command, targetWallet: target, timestamp })
		if (!out.ok) return null
		return { message: out.message, signMessage: out.signature }
	}
	const walletAddress = deps.accountEoaFor(privateKeyArmor)
	const message = JSON.stringify({ command, walletAddress, targetWallet: target, timestamp })
	const signMessage = await deps.pageSign(message, privateKeyArmor)
	return { message, signMessage }
}

/**
 * Whether a probe has a way to sign: a shell signs natively, so it needs no page key; a browser needs its own key.
 * Used by the probe entry points before they try to probe.
 */
export const probeHasSigner = (isShell: boolean, privateKeyArmor: string | null | undefined): boolean =>
	isShell || !!(privateKeyArmor || '').trim()
