/**
 * @jest-environment node
 *
 * The chat worker holds no account key (2026-11-13). Every account signature the worker
 * needs is asked of the host (`signAccount`); the key is not passed to the worker, and the worker never builds a wallet.
 * Read from the sources, so a re-introduced `privateKeyHex` fails here.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

describe('chat worker holds no account key', () => {
	const bridge = read('src/services/chatWorkerBridge.ts')
	const chat = read('src/services/chat.ts')
	const transport = read('src/services/nativeConetChatTransport.ts')

	it('the worker start params carry the EOA and a host signer, not the key', () => {
		expect(bridge).not.toMatch(/privateKeyHex/)
		expect(bridge).toMatch(/\teoaAddress: string\n/)
		expect(bridge).toMatch(/\tsignAccount: AccountSignFn\n/)
		expect(bridge).toMatch(/\t\tsignAccount: p\.signAccount,\n/)
	})

	it('connectToGossipNode passes the host signer and never the key', () => {
		const call = chat.indexOf('const started = await startWorkerGossipListen({')
		expect(call).toBeGreaterThan(0)
		const block = chat.slice(call, chat.indexOf('})', call))
		expect(block).not.toMatch(/privateKeyHex/)
		expect(block).toMatch(/signAccount: pageAccountSigner\(privateKeyArmor\)/)
	})

	it('the page signer refuses in a shell before it builds a wallet', () => {
		const fn = chat.indexOf('const pageAccountSigner = (privateKeyArmor: string): AccountSignFn')
		expect(fn).toBeGreaterThan(0)
		const body = chat.slice(fn, chat.indexOf('\n}\n', fn))
		const refuse = body.indexOf('if (shellChatBlockedNow()) throw')
		const build = body.indexOf('new ethers.Wallet(privateKeyArmor)')
		expect(refuse).toBeGreaterThan(0)
		expect(build).toBeGreaterThan(refuse)
	})

	it('the native transport signs only through the host signer and keeps no key field', () => {
		expect(transport).not.toMatch(/privateKeyHex|signingKeyHex/)
		expect(transport).toMatch(/this\.config\.signAccount\(\{ kind: 'eip191', message \}\)/)
		expect(transport).toMatch(/reply\(false, undefined, 'sign_refused'\)/)
	})

	it('no worker source builds a wallet from a private key (SDK worker sources)', () => {
		const dir = resolve(__dirname, '..', '..', 'vendor', 'conet-chat-sdk', 'src', 'worker')
		const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && statSync(join(dir, f)).isFile())
		expect(files.length).toBeGreaterThan(0)
		for (const f of files) {
			const text = readFileSync(join(dir, f), 'utf8')
			expect({ file: f, hit: /privateKeyHex/.test(text) }).toEqual({ file: f, hit: false })
			expect({ file: f, wallet: /new ethers\.Wallet\(/.test(text) }).toEqual({ file: f, wallet: false })
		}
	})
})
