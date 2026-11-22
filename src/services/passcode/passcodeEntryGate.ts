/**
 * Whether the shell's passcode settings entry is operable (fail closed). Operable only when the hello ack declared wallet.passcode.v1.
 * A missing, unanswered or malformed declared list is not operable. The settings screen keeps its note until this returns true.
 */
import { passcodeCapabilityDeclared } from './passcodeCommands'

export function passcodeEntryOperable(declared: readonly string[] | null | undefined): boolean {
	if (!Array.isArray(declared)) return false
	return passcodeCapabilityDeclared(declared)
}
