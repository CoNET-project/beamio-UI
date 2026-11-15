/**
 * Payment authorization key routing. A shell page with no explicit key signs with the EOA unsealed for this one signature
 * (see shellEoaOperation). A refusal, or a missing or empty authorization, throws AuthorizationSignRefusedError, so no request is
 * sent with an empty payment header. The signature itself is built by the caller-supplied signer.
 */
import { runShellEoaOperation } from './shellEoaOperation'

export class AuthorizationSignRefusedError extends Error {
	readonly code: string
	constructor(code: string) {
		super('Wallet signature unavailable')
		this.name = 'AuthorizationSignRefusedError'
		this.code = code
	}
}

/** Whether a caught error is the refusal above (also across module copies, where instanceof can fail). */
export function isAuthorizationSignRefused(e: unknown): boolean {
	return e instanceof AuthorizationSignRefusedError || (e as { name?: unknown } | null | undefined)?.name === 'AuthorizationSignRefusedError'
}

export type AuthorizationSignInput = {
	amount: bigint
	to: string
	/** An explicit private key given by the caller; it takes precedence. */
	explicitKey: string
	/** Whether the page runs inside a native shell. */
	isShell: boolean
	/** The page-held profile key (browser only). */
	profileKey: string
	/** The sealed credential blob from the page record (shell only). */
	readBlob: () => Promise<string | null>
	/** Builds the authorization for one private key. */
	signWithKey: (privateKey: string, amount: bigint, to: string) => Promise<string>
}

async function signOnce(input: AuthorizationSignInput, explicit: string): Promise<string> {
	if (input.isShell && !explicit) {
		try {
			const blob = await input.readBlob()
			return await runShellEoaOperation(blob, (session) => input.signWithKey(session.signingKey(), input.amount, input.to))
		} catch (ex: any) {
			const code = typeof ex?.code === 'string' ? ex.code : 'error'
			console.log(`AuthorizationSign shell refused: ${code}`)
			throw new AuthorizationSignRefusedError(code)
		}
	}
	const key = explicit || input.profileKey.trim()
	if (!key) throw new AuthorizationSignRefusedError('no_key')
	return input.signWithKey(key, input.amount, input.to)
}

export async function runAuthorizationSign(input: AuthorizationSignInput): Promise<string> {
	const header = await signOnce(input, input.explicitKey.trim())
	if (!header) throw new AuthorizationSignRefusedError('sign_failed')
	return header
}
