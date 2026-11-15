/**
 * Worker signing (2026-11-13): the worker holds no account key. Checks, with a fake Worker and no network:
 *  1. createAccountSigning passes EIP-191 and EIP-712 requests to the host and checksums the address;
 *  2. the relay posts signRequest, resolves on a valid signResponse, and fails on refusal, malformed answer or timeout;
 *  3. the client's init payload never carries the account key, even when a host puts one on the identity object;
 *  4. a worker signRequest is answered by config.signAccount with the signature only; a refusal answers sign_refused;
 *  5. static: no worker source builds a wallet from a private key.
 *
 * Run: npx tsx scripts/testWorkerSigning.ts
 */
import assert from 'node:assert/strict'
import { ethers } from 'ethers'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAccountSigning, type AccountSignRequest } from '../src/signer.js'
import { createWorkerSignRelay } from '../src/worker/remote-sign.js'
import { createBeamioChatClient } from '../src/client.js'
import type { BeamioChatConfig } from '../src/types.js'

const SENTINEL_KEY = '0x' + 'ab'.repeat(32)
const GOOD_SIG = '0x' + '11'.repeat(65)

let passed = 0
const check = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
	await fn()
	passed += 1
	console.log(`ok  ${name}`)
}

class FakeWorker {
	readonly posted: Array<Record<string, unknown>> = []
	private listeners: Record<string, Array<(ev: unknown) => void>> = {}
	addEventListener(type: string, cb: (ev: unknown) => void): void {
		;(this.listeners[type] ??= []).push(cb)
	}
	postMessage(msg: Record<string, unknown>): void {
		this.posted.push(msg)
		if (msg.type === 'init') {
			// Answer the init handshake the way the worker does (an ack carrying the same reqId).
			setTimeout(() => this.emit({ type: 'ack', reqId: msg.reqId, ok: true }), 0)
		}
	}
	emit(data: unknown): void {
		for (const cb of this.listeners.message ?? []) cb({ data })
	}
	terminate(): void {
		/* nothing */
	}
}

const flush = (ms = 15) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
	await check('createAccountSigning passes EIP-191 and EIP-712 requests to the host, checksummed address', async () => {
		const seen: AccountSignRequest[] = []
		const signing = createAccountSigning('0x' + '5a'.repeat(20), async (req) => {
			seen.push(req)
			return GOOD_SIG
		})
		assert.equal(signing.address, ethers.getAddress('0x' + '5a'.repeat(20)))
		assert.equal(await signing.signMessage('hello'), GOOD_SIG)
		const domain = { name: 'x', chainId: 1 }
		const types = { Ping: [{ name: 'n', type: 'uint256' }] }
		assert.equal(await signing.signTypedData(domain, types, { n: 7n }), GOOD_SIG)
		assert.deepEqual(seen[0], { kind: 'eip191', message: 'hello' })
		assert.equal(seen[1].kind, 'eip712')
		assert.deepEqual((seen[1] as { types: unknown }).types, types)
	})

	await check('relay: valid answer resolves, refusal and malformed answers reject, late answer ignored', async () => {
		const posted: unknown[] = []
		const relay = createWorkerSignRelay((m) => posted.push(m))
		const p1 = relay.request({ kind: 'eip191', message: 'a' })
		assert.deepEqual(posted[0], { type: 'signRequest', reqId: 1, request: { kind: 'eip191', message: 'a' } })
		relay.onResponse({ type: 'signResponse', reqId: 1, ok: true, signature: GOOD_SIG })
		assert.equal(await p1, GOOD_SIG)

		const p2 = relay.request({ kind: 'eip191', message: 'b' })
		relay.onResponse({ type: 'signResponse', reqId: 2, ok: false, error: 'sign_refused' })
		await assert.rejects(p2, /sign_refused/)

		const p3 = relay.request({ kind: 'eip191', message: 'c' })
		relay.onResponse({ type: 'signResponse', reqId: 3, ok: true, signature: 'not-hex' })
		await assert.rejects(p3, /account_sign_refused/)

		relay.onResponse({ type: 'signResponse', reqId: 999, ok: true, signature: GOOD_SIG }) // unknown: ignored
	})

	await check('relay: no answer fails after the timeout (a stuck host cannot hang the worker)', async () => {
		const relay = createWorkerSignRelay(() => undefined, 20)
		await assert.rejects(relay.request({ kind: 'eip191', message: 'slow' }), /account_sign_timeout/)
	})

	const hostSigns: AccountSignRequest[] = []
	const config = {
		identity: {
			eoaAddress: '0x' + '5a'.repeat(20),
			// A host that puts the key on the identity object must not leak it to the worker.
			privateKeyHex: SENTINEL_KEY,
			pgpPrivateKeyArmored: 'PGP-ARMOR-PLACEHOLDER',
			pgpPassphrase: '',
			pgpPublicKeyArmored: 'PGP-PUB-PLACEHOLDER',
			ownRouteArmoredPublicKey: '',
		},
		conetRpcUrl: 'https://rpc.invalid',
		addressPgpContractAddress: '0x' + '00'.repeat(20),
		getNodes: async () => [],
		ipfsBaseUrl: 'https://ipfs.invalid',
		signAccount: async (req: AccountSignRequest) => {
			hostSigns.push(req)
			if (req.kind === 'eip191' && req.message === 'refuse-me') throw new Error('user declined')
			if (req.kind === 'eip191' && req.message === 'garbage') return 'not-a-signature'
			return GOOD_SIG
		},
	} as unknown as BeamioChatConfig

	const fake = new FakeWorker()
	const client = createBeamioChatClient(config, { workerFactory: () => fake as unknown as Worker })
	await check('client init payload carries no account key and only the identity fields', async () => {
		await client.init()
		const init = fake.posted.find((m) => m.type === 'init') as { payload: { identity: Record<string, unknown> } }
		assert.ok(init, 'init was posted')
		assert.equal(JSON.stringify(fake.posted).includes(SENTINEL_KEY.slice(2)), false, 'key bytes must not be posted')
		assert.deepEqual(
			Object.keys(init.payload.identity).sort(),
			['eoaAddress', 'ownRouteArmoredPublicKey', 'pgpPassphrase', 'pgpPrivateKeyArmored', 'pgpPublicKeyArmored'].sort(),
		)
		client.destroy?.()
	})

	await check('worker signRequest is answered with the host signature only', async () => {
		const fresh = new FakeWorker()
		const c2 = createBeamioChatClient(config, { workerFactory: () => fresh as unknown as Worker })
		await c2.init()
		fresh.emit({ type: 'signRequest', reqId: 7, request: { kind: 'eip191', message: 'envelope' } })
		await flush()
		const reply = fresh.posted.find((m) => m.type === 'signResponse' && m.reqId === 7) as Record<string, unknown>
		assert.ok(reply, 'signResponse posted')
		assert.equal(reply.ok, true)
		assert.equal(reply.signature, GOOD_SIG)
		assert.equal(JSON.stringify(reply).includes(SENTINEL_KEY.slice(2)), false)
		c2.destroy?.()
	})

	await check('a refused or malformed host answer reaches the worker as a short code', async () => {
		const fresh = new FakeWorker()
		const c3 = createBeamioChatClient(config, { workerFactory: () => fresh as unknown as Worker })
		await c3.init()
		fresh.emit({ type: 'signRequest', reqId: 8, request: { kind: 'eip191', message: 'refuse-me' } })
		fresh.emit({ type: 'signRequest', reqId: 9, request: { kind: 'eip191', message: 'garbage' } })
		await flush()
		const r8 = fresh.posted.find((m) => m.type === 'signResponse' && m.reqId === 8) as Record<string, unknown>
		const r9 = fresh.posted.find((m) => m.type === 'signResponse' && m.reqId === 9) as Record<string, unknown>
		assert.equal(r8.ok, false)
		assert.equal(r8.error, 'sign_refused')
		assert.equal(r9.ok, false)
		assert.equal(r9.error, 'bad_signature')
		assert.ok(!JSON.stringify(r8).includes('user declined'), 'the host error text must not cross into the worker')
		c3.destroy?.()
	})

	await check('static: no worker source builds a wallet from a private key', () => {
		const dir = fileURLToPath(new URL('../src/worker', import.meta.url))
		const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && statSync(resolve(dir, f)).isFile())
		for (const f of files) {
			const text = readFileSync(resolve(dir, f), 'utf8')
			assert.equal(/privateKeyHex/.test(text), false, `${f} mentions privateKeyHex`)
			assert.equal(/new ethers\.Wallet\(/.test(text), false, `${f} builds a wallet`)
		}
		const clientText = readFileSync(fileURLToPath(new URL('../src/client.ts', import.meta.url)), 'utf8')
		assert.equal(/privateKeyHex/.test(clientText), false, 'client.ts mentions privateKeyHex')
	})

	console.log(`\nPASS ${passed} checks (worker signing)`)
}

main().catch((err) => {
	console.error('FAIL', err)
	process.exit(1)
})
