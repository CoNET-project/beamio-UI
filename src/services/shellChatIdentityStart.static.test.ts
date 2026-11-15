/**
 * @jest-environment node
 *
 * Shell chat start from the native public identity (PWA). Reads the sources.
 * The start runs before any page-key step, reads identityPublic, sets the native voice relay nodes before the listen,
 * retries only a failed start, and the restart keeps the public address (never a key).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8')

describe('shell chat start on the native public identity', () => {
	const chat = read('services/chat.ts')
	const start = read('services/shellChatStart.ts')

	it('the identityPublic start runs in initChat before any page-key step', () => {
		const shellStart = chat.indexOf('startShellChatFromNativeIdentity(shellChatStartDeps(')
		const pageKeyStep = chat.indexOf('const temp = CoNET_Data', shellStart)
		expect(shellStart).toBeGreaterThan(0)
		expect(pageKeyStep).toBeGreaterThan(shellStart)
	})

	it('the shell start reads identityPublic and does not read the page key', () => {
		expect(chat).toContain('readIdentity: readNativeIdentityPublic')
		expect(start).toContain("eoaAddress: id.eoa")
		expect(start).not.toMatch(/privateKeyArmor|pgpPrivateKeyArmored:\s*[^'"\s]/)
	})

	it('a failed start is retried; a missing PGP record or G1 is not retried from here', () => {
		expect(start).toContain("return 'not_ready'")
		expect(start).toContain("return 'pgp_not_ready'")
		expect(start).toContain('deps.retry(')
	})

	it('the native voice relay nodes are set before the native listen starts', () => {
		const relay = chat.indexOf('setNativeVoiceRelayNodes(n as unknown as nodeInfo[])')
		const listen = chat.indexOf('startListen: (p) =>')
		expect(relay).toBeGreaterThan(0)
		expect(listen).toBeGreaterThan(relay)
	})
})

describe('the native public address survives a restart', () => {
	const wallet = read('services/nativeWallet.ts')

	it('the EOA is stored as a public address only, and a restart reads it when the memory hint is empty', () => {
		// One implementation of the kept address: the shell identity source, used by the native wallet.
		expect(wallet).toContain("from './shellIdentitySource'")
		expect(wallet).toContain('persistShellEoa(nativeEoaHint)')
		expect(wallet).toContain('const hint = nativeEoaHint ?? persistedNativeEoa()')
		const source = read('services/shellIdentitySource.ts')
		expect(source).toContain("const STORAGE_KEY = 'beamio.shellPublicEoa.v1'")
		expect(wallet).not.toMatch(/localStorage\.setItem\([^)]*(privateKey|mnemonic|passcode|recovery)/i)
	})
})
