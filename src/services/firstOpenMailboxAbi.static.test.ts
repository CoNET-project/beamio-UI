/**
 * The worker first-open contract must include AddressPGP nodeKeyExists.
 * isRecorded calls it before POST /api/regiestChatRoute. A missing fragment throws inside
 * ethers, pickRecordedMailbox returns error, and the page only sees pending_confirm.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { ethers } from 'ethers'

const root = join(__dirname, '../..')
const src = readFileSync(join(root, 'vendor/conet-chat-sdk/src/worker/first-open.ts'), 'utf8')
const dist = readFileSync(join(root, 'vendor/conet-chat-sdk/dist/worker/first-open.js'), 'utf8')

function fragments(text: string): string[] {
	const at = text.indexOf('PGP_MANAGER_FIRST_OPEN_ABI')
	const block = text.slice(at, text.indexOf(']', at))
	return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('first-open mailbox ABI', () => {
	it('the source and the built worker ABI can encode nodeKeyExists', () => {
		for (const text of [src, dist]) {
			const iface = new ethers.Interface(fragments(text))
			expect(iface.getFunction('nodeKeyExists')).toBeTruthy()
			expect(iface.getFunction('searchKey')).toBeTruthy()
		}
	})

	it('isRecorded uses nodeKeyExists from that ABI', () => {
		const abiAt = src.indexOf('export const PGP_MANAGER_FIRST_OPEN_ABI')
		const recordedAt = src.indexOf('isRecorded: async (routeKeyID) => Boolean(await pgp.nodeKeyExists')
		expect(abiAt).toBeGreaterThan(0)
		expect(src.slice(abiAt, recordedAt)).toMatch(/function nodeKeyExists\(bytes32\) view returns \(bool\)/)
		expect(recordedAt).toBeGreaterThan(abiAt)
	})

	it('a mailbox that is not ok never reaches regiestChatRoute', () => {
		const fn = src.slice(src.indexOf('async function registerOnce'), src.indexOf('const deps: FirstOpenDeps'))
		const pick = fn.indexOf("if (pick.status !== 'ok') return 'retry'")
		const post = fn.indexOf('env.post(')
		expect(pick).toBeGreaterThan(0)
		expect(post).toBeGreaterThan(pick)
	})
})
