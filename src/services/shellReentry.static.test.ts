/**
 * @jest-environment node
 */
/**
 * 0.53.47: the shell start is re-entered after a native wallet-ready event and once on pgp_migration_retry; both are bounded and the
 * per-account guards of the start are not bypassed. Source pins (the start itself is covered by shellChatStart.test.ts).
 */
import * as fs from 'fs'
import * as path from 'path'

const chat = fs.readFileSync(path.join(__dirname, 'chat.ts'), 'utf8')

describe('shell start re-entry (chat.ts)', () => {
	it('listens to the native wallet-ready event and to pgpUpgradeState, installed once when the shell start runs', () => {
		expect(chat).toMatch(/window\.addEventListener\(NATIVE_WALLET_READY_EVENT/)
		expect(chat).toMatch(/subscribePgpUpgradeState\(\(code\) => \{\s*if \(code === 'pgp_migration_retry'\)/)
		expect(chat).toMatch(/installShellReentry\(\)\n\t\tinitChatInProgress = true/)
		expect(chat).toMatch(/if \(shellReentryInstalled \|\| typeof window === 'undefined'\) return/)
	})
	it('the wallet-ready restart has no count limit but a 1 s debounce, skips a running start and a started chat, and reuses initChat (its guards apply)', () => {
		const fn = chat.slice(chat.indexOf('export function restartShellChatAfterWalletReady'), chat.indexOf('export function restartShellChatAfterMigrationRetry'))
		expect(fn).toMatch(/initChatInProgress/)
		expect(fn).toMatch(/lastShellStartResult === 'started'/)
		expect(fn).toMatch(/nowMs - lastWalletReadyAskAt < REASK_DEBOUNCE_MS/)
		expect(fn).not.toMatch(/WALLET_READY_RESTART_MAX|walletReadyRestarts/)
		expect(fn).toMatch(/void initChat\(/)
		expect(chat).toMatch(/const REASK_DEBOUNCE_MS = 1_000/)
	})
	it('the migration-retry restart runs only while no evaluation was entered, and only once', () => {
		const fn = chat.slice(chat.indexOf('export function restartShellChatAfterMigrationRetry'), chat.indexOf('/** Test hook'))
		expect(fn).toMatch(/evaluateEntered \|\| upgradeRetryTriggered/)
		expect(fn).toMatch(/upgradeRetryTriggered = true/)
		expect(chat).toMatch(/evaluatePgp: \(\) => \{\s*evaluateEntered = true/)
	})
	it('no WebSocket and no unbounded timer loop is introduced by the re-entry', () => {
		const block = chat.slice(chat.indexOf('const REASK_DEBOUNCE_MS'), chat.indexOf('const installShellReentry') + 600)
		expect(block).not.toMatch(/WebSocket|setInterval/)
	})
})
