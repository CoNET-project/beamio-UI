/**
 * The passcode commands (FROZEN protocol section one, 6 and 7 and section three). Pure: the command is built from an allowlist per command;
 * a field outside the list, a missing field, an unknown command or a malformed value is refused before anything is sent. The capability gate
 * is checked first: a shell that does not declare wallet.passcode.v1 receives no passcode command (fail closed).
 *
 * Secrets: `phrase`, `passcode`, `oldPasscode` and `newPasscode` are the credential fields. They are only ever in the command for the commands
 * that list them; this module never logs or returns them.
 */
import { shellPasscodeReqIdFor } from '../reqIdSpaces'

export const PASSCODE_CAPABILITY = 'wallet.passcode.v1'

/** The allowlist per command (protocol section one, table in 6). */
export const PASSCODE_COMMAND_FIELDS: Readonly<Record<string, readonly string[]>> = {
	passcodeProvision: ['type', 'reqId', 'eoa', 'phrase', 'passcode'],
	passcodeUnlock: ['type', 'reqId', 'eoa', 'passcode'],
	passcodeChange: ['type', 'reqId', 'eoa', 'oldPasscode', 'newPasscode'],
	passcodeDisable: ['type', 'reqId', 'eoa', 'passcode'],
	nativeRepairProvide: ['type', 'reqId', 'eoa', 'phrase', 'passcode', 'requestReqId'],
	passcodeStatus: ['type', 'reqId', 'eoa'],
	// 2026-11-20 native unlock persistence: same-mnemonic check, public eoa only
	nativeIdentityCheck: ['type', 'reqId', 'eoa'],
}

/** The credential fields that may cross the bridge, and only inside the commands above. */
export const CREDENTIAL_FIELDS: readonly string[] = ['phrase', 'passcode', 'oldPasscode', 'newPasscode']

/** The required fields per command (every listed field except the optional ones). */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
	passcodeProvision: ['reqId', 'eoa', 'phrase', 'passcode'],
	passcodeUnlock: ['reqId', 'eoa', 'passcode'],
	passcodeChange: ['reqId', 'eoa', 'oldPasscode', 'newPasscode'],
	passcodeDisable: ['reqId', 'eoa', 'passcode'],
	nativeRepairProvide: ['reqId', 'eoa', 'phrase', 'passcode', 'requestReqId'],
	passcodeStatus: ['reqId', 'eoa'],
	nativeIdentityCheck: ['reqId', 'eoa'],
}

const EOA_RE = /^0x[0-9a-f]{40}$/

/** True only when the shell declared the passcode capability in the hello ack (the caller passes the declared list). */
export function passcodeCapabilityDeclared(declared: readonly string[]): boolean {
	return declared.includes(PASSCODE_CAPABILITY)
}

export type BuildRefusal = 'unknown_command' | 'extra_field' | 'missing_field' | 'bad_value'
export type BuildResult = { ok: true; command: Record<string, unknown> } | { ok: false; reason: BuildRefusal }

/**
 * Builds one command from its fields. The reqId is taken from the page's passcode range (shellPasscodeReqIdFor); a counter past the range
 * throws there and is not caught here. The values are checked for shape only: eoa lower-case hex address; reqId a non-negative safe integer.
 */
export function buildPasscodeCommand(type: string, fields: Record<string, unknown>): BuildResult {
	const allowed = PASSCODE_COMMAND_FIELDS[type]
	if (!allowed) return { ok: false, reason: 'unknown_command' }
	// `type` is the command name (the first argument), never an input field: a caller that passes it is refused.
	for (const key of Object.keys(fields)) {
		if (key === 'type' || !allowed.includes(key)) return { ok: false, reason: 'extra_field' }
	}
	for (const key of REQUIRED[type]) {
		if (fields[key] === undefined || fields[key] === null || fields[key] === '') return { ok: false, reason: 'missing_field' }
	}
	if (typeof fields.eoa !== 'string' || !EOA_RE.test(fields.eoa)) return { ok: false, reason: 'bad_value' }
	const reqId = fields.reqId
	if (typeof reqId !== 'number' || !Number.isSafeInteger(reqId) || reqId < 0) return { ok: false, reason: 'bad_value' }
	const command: Record<string, unknown> = { type }
	for (const key of allowed) {
		if (key === 'type') continue
		command[key] = fields[key]
	}
	return { ok: true, command }
}

export type SendRefusal = BuildRefusal | 'capability_missing'
export type SendOutcome = { kind: 'sent' } | { kind: 'refused'; reason: SendRefusal }

/**
 * Sends one passcode command through `send` (the bridge) only when the capability is declared and the command is well formed. A refusal
 * never reaches `send`, so no credential leaves the page for a shell that cannot handle it.
 */
export function sendPasscodeCommand(
	declared: readonly string[],
	type: string,
	fields: Record<string, unknown>,
	send: (command: Record<string, unknown>) => void,
): SendOutcome {
	if (!passcodeCapabilityDeclared(declared)) return { kind: 'refused', reason: 'capability_missing' }
	const built = buildPasscodeCommand(type, fields)
	if (!built.ok) return { kind: 'refused', reason: built.reason }
	send(built.command)
	return { kind: 'sent' }
}

/** The page's counter range for the passcode commands (reqIdSpaces). */
export function nextPasscodeReqId(counter: number): number {
	return shellPasscodeReqIdFor(counter)
}
