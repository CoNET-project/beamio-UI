/**
 * the two probe call sites in chat.ts go through one helper. In a shell the helper calls the native command
 * `mailboxProbeSign` and uses its message; a browser page keeps its own key. Reads the source (chat.ts imports too much to load here).
 */
import fs from 'fs'
import path from 'path'

const chat = fs.readFileSync(path.join(__dirname, 'chat.ts'), 'utf8')

const body = (start: string): string => {
	const at = chat.indexOf(start)
	if (at < 0) return ''
	const open = chat.indexOf('{', chat.indexOf('=>', at))
	let depth = 0
	for (let i = open; i < chat.length; i += 1) {
		if (chat[i] === '{') depth += 1
		if (chat[i] === '}') {
			depth -= 1
			if (depth === 0) return chat.slice(at, i + 1)
		}
	}
	return ''
}

describe('the probe signature in a shell is the native command', () => {
	it('chat.ts imports the native probe command', () => {
		expect(chat).toContain("import { nativeMailboxProbeSign, type MailboxProbeCommand } from '@/services/nativeMailboxProbe'")
	})

	it('the decision is in mailboxProbeSigning.ts: the shell branch comes first and returns the native message and signature', () => {
		const mod = fs.readFileSync(path.join(__dirname, 'mailboxProbeSigning.ts'), 'utf8')
		expect(chat).toContain("import { probeHasSigner, signMailboxProbe } from '@/services/mailboxProbeSigning'")
		expect(mod).toContain('if (deps.isShell()) {')
		expect(mod).toContain('const out = await deps.nativeProbeSign({ command, targetWallet: target, timestamp })')
		expect(mod).toContain('return { message: out.message, signMessage: out.signature }')
		expect(mod.indexOf('deps.nativeProbeSign(')).toBeLessThan(mod.indexOf('deps.pageSign('))
	})

	it('the page signs with its own key only in the browser branch: selfAuth appears once, as the browser signer', () => {
		expect(chat.split("signAccountMessageFor({ kind: 'selfAuth'").length - 1).toBe(1)
		expect(body('export const queryMailboxWalletOnline = async (')).not.toContain("kind: 'selfAuth'")
		expect(body('export const queryMailboxNativeWakeable = async (')).not.toContain("kind: 'selfAuth'")
	})

	it('the two query functions use the helper with their own command name', () => {
		expect(body('export const queryMailboxWalletOnline = async (')).toContain("probeSignedMessage('wallet_online_query', targetWallet, privateKeyArmor)")
		expect(body('export const queryMailboxNativeWakeable = async (')).toContain("probeSignedMessage('wallet_native_wake_query', targetWallet, privateKeyArmor)")
	})

	it('a shell has no page key, so the key checks in the probe functions apply to the browser only', () => {
		expect(body('export const queryMailboxWalletOnline = async (')).toContain('if (!probeHasSigner(isShellContext(), privateKeyArmor)) return null')
		expect(body('export const queryMailboxNativeWakeable = async (')).toContain('if (!probeHasSigner(isShellContext(), privateKeyArmor)) return null')
		expect(chat).toContain('if (!chats?.length || !probeHasSigner(isShellContext(), privateKeyArmor)) return out')
	})
})
