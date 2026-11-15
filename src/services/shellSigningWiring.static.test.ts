/**
 * @jest-environment node
 *
 * Matrix v2  /  /  (read from the sources, so a re-introduced page signature fails here):
 *  - the envelope, the mailbox probes and the delivery ack sign through the account signer (shell: native; browser: page key);
 *  - a shell never builds a page wallet for these signatures, and the ack shape is never signed under another kind;
 *  - the chat route registration refuses the page key in a shell.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

describe('signing in a shell goes to the native layer (matrix v2)', () => {
	const chat = read('src/services/chat.ts')
	const receipt = read('src/utils/chatDeliveryReceipt.ts')
	const ack = read('src/services/gossipAckSign.ts')

	it('the 1:1 envelope is signed through the account signer (kind envelope)', () => {
		expect(chat).toMatch(/signAccountMessageFor\(\{ kind: 'envelope', message: text, privateKeyArmor \}\)/)
	})

	it('the mailbox online and wake probes go through one helper; the page account signer (selfAuth) is used once, in the browser branch only', () => {
		const calls = chat.match(/signAccountMessageFor\(\{ kind: 'selfAuth', message, privateKeyArmor: armor \}\)/g) ?? []
		expect(calls.length).toBe(1)
		expect(chat).toContain("probeSignedMessage('wallet_online_query', targetWallet, privateKeyArmor)")
		expect(chat).toContain("probeSignedMessage('wallet_native_wake_query', targetWallet, privateKeyArmor)")
	})

	it('chat.ts signs a message with a page wallet only in the browser page signer', () => {
		const hits = [...chat.matchAll(/wallet\.signMessage\(/g)].map((m) => m.index ?? -1)
		expect(hits.length).toBe(1)
		expect(hits[0]).toBeGreaterThan(chat.indexOf('const pageAccountSigner = '))
		expect(hits[0]).toBeLessThan(chat.indexOf('export const connectToGossipNode'))
	})

	it('the delivery receipt takes the EOA and the signing check from the account helpers, not from the key alone', () => {
		expect(receipt).not.toMatch(/eoaOfKey\(/)
		expect(receipt).toMatch(/accountEoaFor\(privateKeyArmor\)/)
		expect(receipt).toMatch(/canSignAccount\(privateKeyArmor\)/)
	})

	it('the ack signer asks in a shell before it touches the page wallet core', () => {
		const shell = ack.indexOf('if (isShellContext()) {')
		const native = ack.indexOf('await nativeSignGossip(message)')
		const core = ack.indexOf("command: 'signGossip'")
		expect(shell).toBeGreaterThan(0)
		expect(native).toBeGreaterThan(shell)
		expect(core).toBeGreaterThan(native)
	})
})

describe('chat route registration refuses the page key in a shell', () => {
	const chat = read('src/services/chat.ts')

	it('regiestChatRoute refuses first in a shell; the shell registers through the native command', () => {
		const fn = chat.indexOf('export const regiestChatRoute = async (')
		const refusal = chat.indexOf('if (isShellContext()) {', fn)
		const sign = chat.indexOf('new ethers.Wallet(privateKey)', fn)
		expect(fn).toBeGreaterThan(0)
		expect(refusal).toBeGreaterThan(fn)
		expect(sign).toBeGreaterThan(refusal)
		expect(chat).toMatch(/registered = await regiestChatRouteNative\(/)
	})
})
