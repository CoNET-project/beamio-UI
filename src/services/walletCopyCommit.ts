/**
 * H2: what a store read may do to the page's copy (CoNET_Data), the UI language and the store. A read for a user
 * action (a probe) only answers its caller: the page copy is the basis of the next save, and replacing it with the store's record would
 * drop a pending change the page still holds. The start-up read builds the copy and applies its language.
 */
export type StoredRecord = { cleaned: Record<string, unknown>; hadPeerPrivateArmored: boolean }

export type StoredReadEffects = {
	/** Replaces the page copy (null: no wallet). */
	setCopy(data: Record<string, unknown> | null): void
	/** Writes the cleaned copy back once (the peer-chat private armor was removed). */
	writeBack(): void
	/** Applies the language stored in the copy. */
	applyLanguage(language: string): Promise<void> | void
}

export async function commitStoredRead(options: { probe?: boolean }, record: StoredRecord | null, fx: StoredReadEffects): Promise<void> {
	if (options.probe) return
	if (record === null) {
		fx.setCopy(null)
		return
	}
	fx.setCopy(record.cleaned)
	if (record.hadPeerPrivateArmored) fx.writeBack()
	const beamio = record.cleaned.beamio as { language?: unknown } | undefined
	const language = beamio?.language
	if (typeof language === 'string' && language) await fx.applyLanguage(language)
}
