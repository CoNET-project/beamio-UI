/**
 * The one rule for a typed BeamioTag / username (create and restore use it). Removes every "@", trims, applies NFKC (fullwidth
 * forms become ASCII), and strips zero-width characters. Case is not changed here; the lookup key is lower-cased downstream.
 */
export function normalizeBeamioTagInput(raw: string): string {
	return String(raw)
		.replace(/@/g, '')
		.trim()
		.normalize('NFKC')
		.replace(/[​-‍﻿]/g, '')
}

/** The one validation rule for a BeamioTag typed on create or restore (the create screen is the reference). */
export const BEAMIO_TAG_PATTERN = /^[a-zA-Z0-9_\.]{3,26}$/
/** The message shown for a tag that fails BEAMIO_TAG_PATTERN (the same key on create and restore). */
export const BEAMIO_TAG_MESSAGE_KEY = 'use_3_20_letters_numbers_dots_or_underscores'
