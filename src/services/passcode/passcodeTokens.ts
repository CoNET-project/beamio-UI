/** Visual tokens (passcode-tokens.v1.json, copied from the interface maintainers' file). Used by the PWA; the shells generate constants from the same file. */
import tokens from './passcode-tokens.v1.json'

export interface PasscodeTokens {
	color: { bg: string; fg: string; fgMuted: string; accent: string; onAccent: string; danger: string; warn: string; surface: string; border: string }
	font: { title: { size: number; weight: number }; body: { size: number; weight: number }; caption: { size: number; weight: number } }
	dot: { size: number; gap: number }
	keypad: { key: { width: number; height: number; radius: number } }
	radius: { card: number }
	motion: { shake: { durationMs: number; amplitude: number } }
	touch: { minTarget: number }
}

export const PASSCODE_TOKENS = tokens as unknown as PasscodeTokens
