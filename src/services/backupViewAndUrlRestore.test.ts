/**
 * @jest-environment node
 *
 * Matrix v2: the private key and the recovery code are shown by the native layer (`walletBackupView`),
 * and a recovery code is never restored from the URL. The shell branches come before any key is read on the page.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { NATIVE_BACKUP_VIEW_COMMAND, nativeWalletBackupView } from './nativeSigning'
import { NATIVE_KEYS_CAPABILITY } from './shellChatState'

type Sent = Record<string, unknown>
type Win = EventTarget & { CashTreesIOS?: unknown }
const w = new EventTarget() as Win
;(globalThis as unknown as { window: Win }).window = w
class ShellCustomEvent extends Event {
	readonly detail: unknown
	constructor(type: string, init?: { detail?: unknown }) {
		super(type)
		this.detail = init?.detail
	}
}
;(globalThis as unknown as { CustomEvent: typeof ShellCustomEvent }).CustomEvent = ShellCustomEvent

let sent: Sent[] = []

function installShell(caps: string[], reply: Record<string, unknown>): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const send = (payload: Record<string, unknown>) =>
				setTimeout(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } })), 0)
			if (cmd.type === 'hello') send({ type: 'ack', reqId: cmd.reqId, ok: true, result: { capabilities: caps } })
			else if (cmd.type === NATIVE_BACKUP_VIEW_COMMAND) send({ ...reply, reqId: cmd.reqId })
		},
	}
}

beforeEach(() => {
	sent = []
})
afterEach(() => {
	delete w.CashTreesIOS
})

describe('nativeWalletBackupView', () => {
	it('without the chat capability: native_unavailable, and nothing is sent', async () => {
		installShell([], { type: 'ack', ok: true })
		await expect(nativeWalletBackupView('privateKey')).resolves.toEqual({ ok: false, reason: 'native_unavailable' })
		expect(sent.map((c) => c.type)).not.toContain(NATIVE_BACKUP_VIEW_COMMAND)
	})

	it('sends only type, kind and reqId; an ack without a result is success (nothing comes back)', async () => {
		installShell([NATIVE_KEYS_CAPABILITY, 'wallet.backup-view.v1'], { type: 'ack', ok: true })
		await expect(nativeWalletBackupView('recoveryCode')).resolves.toEqual({ ok: true })
		const cmd = sent.find((c) => c.type === NATIVE_BACKUP_VIEW_COMMAND) as Sent
		expect(Object.keys(cmd).sort()).toEqual(['kind', 'reqId', 'type'])
		expect(cmd.kind).toBe('recoveryCode')
	})

	it('a kind outside privateKey, mnemonic and recoveryCode is refused without sending', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true })
		await expect(nativeWalletBackupView('raw' as never)).resolves.toEqual({ ok: false, reason: 'kind_not_allowed' })
		expect(sent.map((c) => c.type)).not.toContain(NATIVE_BACKUP_VIEW_COMMAND)
	})

	it('a refusal from the native layer returns its code', async () => {
		installShell([NATIVE_KEYS_CAPABILITY, 'wallet.backup-view.v1'], { type: 'ack', ok: false, error: 'user_cancelled' })
		await expect(nativeWalletBackupView('privateKey')).resolves.toEqual({ ok: false, reason: 'user_cancelled' })
	})
})

describe('wiring in the sources', () => {
	const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

	it('LoadingPage takes no recovery code from the URL', () => {
		const page = read('src/pages/Home/LoadingPage.tsx')
		expect(page).not.toMatch(/masterKeyParam/)
		expect(page).not.toMatch(/restoreWithRedeem\(/)
		expect(page).not.toMatch(/setRestoreFromUrlMasterKey\(masterKeyParam\)/)
		expect(page).toMatch(/\(matrix v2\): a recovery code is never taken from the URL/)
	})

	it('PrivateKey asks the shell first; the page key read comes after that guard', () => {
		const pk = read('src/components/Setting/PrivateKey/PrivateKey.tsx')
		const guard = pk.indexOf("nativeWalletBackupView('privateKey')")
		const read1 = pk.indexOf('restoreWithUserPin(')
		expect(guard).toBeGreaterThan(0)
		expect(read1).toBeGreaterThan(guard)
		expect(pk).toMatch(/if \(isShellContext\(\)\) \{[\s\S]{0,300}nativeWalletBackupView\('privateKey'\)/)
	})

	it('recoverQR asks the shell first; the account key use comes after that guard', () => {
		const qr = read('src/components/Setting/PrivateKey/recoverQR.tsx')
		const guard = qr.indexOf("nativeWalletBackupView('recoveryCode')")
		const useKey = qr.indexOf('RegenerateRecover(')
		expect(guard).toBeGreaterThan(0)
		expect(useKey).toBeGreaterThan(guard)
	})
})
