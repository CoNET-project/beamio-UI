/**
 * QA-build-only diagnostic lines for the on-screen QA display of the shells (iOS shows console lines that start with "[send]" or "[persist]").
 * Exists only when the build sets REACT_APP_QA_BRIDGE_COUNTER=true; in every other build each function returns at once (build-time constant).
 * Codes and integers only: the text is cut to [A-Za-z0-9 _.:=/-] and 160 characters, so no address, content, key or fingerprint can pass through.
 */
const on = (): boolean => process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true'

export function qaLine(prefix: '[send]' | '[persist]' | '[net]', text: string): void {
	if (!on()) return
	const clean = String(text).replace(/[^A-Za-z0-9 _.:=/-]/g, '?').slice(0, 150)
	const line = `${prefix} ${clean}`
	console.log(line)
	// the shells' own debug-log channel (the one every other page log uses); a QA screen that reads only that channel sees these lines too
	try {
		const w = window as unknown as { CashTreesIOS?: { debugLog?: (l: string, t: string) => void }; CashTreesAndroid?: { debugLog?: (l: string, t: string) => void } }
		if (typeof w.CashTreesIOS?.debugLog === 'function') w.CashTreesIOS.debugLog('info', line)
		else if (typeof w.CashTreesAndroid?.debugLog === 'function') w.CashTreesAndroid.debugLog('info', line)
	} catch {
		// diagnostics only
	}
}

/** The last early-exit code of a send (access_refused, no_entry, no_route, daemon_not_ready, native_error), read by the failure line. */
let sendStage = ''
export function qaSendStage(code: string): void {
	if (!on()) return
	sendStage = code
}
export function qaTakeSendStage(): string {
	const s = sendStage
	sendStage = ''
	return s
}

/** QA only: a thrown error as a code. An error message that is itself a code (lowercase letters, digits, underscore) prints as is; anything else is `other`. */
export function qaErrorCode(err: unknown): string {
	const m = err instanceof Error ? err.message : ''
	// a message of the form `code: detail` prints its code (the part before the first colon), never the detail
	const hit = /^([a-z0-9_]{1,40})(?::|$)/.exec(m)
	return hit ? hit[1] : 'other'
}

/** QA only: the error's own name (a DOMException name such as QuotaExceededError, or Error.name), cut to letters and digits. Never the message text. */
export function qaErrorName(err: unknown): string {
	const n = typeof (err as { name?: unknown })?.name === 'string' ? ((err as { name: string }).name) : ''
	const clean = n.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)
	return clean || 'none'
}

/** The step a persistence write was at when it failed (a name from a fixed list), set by the writer and read by the failure line. */
let persistStage = 'start'
export function qaPersistStage(stage: string): void {
	persistStage = stage
}
export function qaPersistStageNow(): string {
	return persistStage
}
