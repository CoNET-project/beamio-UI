/**
 * Copy of the passcode settings (a review of the passcode copy): the title and the intro follow the capability that is live. The
 * numeric passcode is available; passkey and Face ID are not. No line may call the screen UI-only.
 * The Chinese wording is provisional, for the project owner to confirm.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import en from './en.json'
import zhCN from './zh-CN.json'

const ui = (d: unknown) => (d as { ui: Record<string, string> }).ui

describe('passcode settings copy', () => {
	it('English: the title is "Passcode"; the intro says the passcode is available and passkey / Face ID are not', () => {
		expect(ui(en).passcode_settings_title).toBe('Passcode')
		expect(ui(en).passcode_settings_intro).toContain('numeric passcode is available now')
		expect(ui(en).passcode_settings_intro).toContain('passkey and Face ID are not active yet')
	})

	it('Simplified Chinese: the title is "数字口令"; the intro says the same', () => {
		expect(ui(zhCN).passcode_settings_title).toBe('数字口令')
		expect(ui(zhCN).passcode_settings_intro).toContain('数字口令现已可用')
		expect(ui(zhCN).passcode_settings_intro).toContain('通行密钥与面容 ID 尚未启用')
	})

	it('the old title key is gone from both locales', () => {
		expect(ui(en)).not.toHaveProperty('passkey_face_id')
		expect(ui(zhCN)).not.toHaveProperty('passkey_face_id')
	})

	it('the passkey page carries no "UI-only" or "not live" wording of its own (the copy comes from the locale)', () => {
		const src = readFileSync(join(__dirname, '..', 'components', 'Setting', 'BeamioPasskeyFaceIDSettingsScreen.tsx'), 'utf8')
		expect(src).not.toMatch(/UI-only/)
		expect(src).not.toMatch(/app lock is not live/)
		expect(src).toContain("tu('passcode_settings_title')")
		expect(src).toContain("tu('passcode_settings_intro')")
	})
})

describe('sync pending copy (f3 follow-up, item 2): an i18n key in both locales, no hard-coded string', () => {
	it('the key exists in English and Simplified Chinese, and the Chinese is not the English text', () => {
		expect(ui(en).passcode_sync_pending).toBe('Passcode saved. Waiting for the app to confirm the sync; it is not complete yet.')
		expect(ui(zhCN).passcode_sync_pending).toBe('口令已保存，等待应用确认同步，尚未完成。')
		expect(ui(zhCN).passcode_sync_pending).not.toBe(ui(en).passcode_sync_pending)
	})

	it('the settings screen reads the key through tu and the message module no longer hard-codes it', () => {
		const screen = readFileSync(join(__dirname, '../components/Setting/PasscodeSettingsSection.tsx'), 'utf8')
		expect(screen).toContain("tu('passcode_sync_pending')")
		const messages = readFileSync(join(__dirname, '../services/passcode/passcodeMessages.ts'), 'utf8')
		expect(messages).not.toContain('Waiting for the app to confirm')
	})
})
