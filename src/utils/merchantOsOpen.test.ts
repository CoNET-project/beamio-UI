/**
 * (A, B, F): the Business OS link for a temp account carries neither the passcode nor a private key, the
 * temp account is unlocked once (no polling), and a failure opens nothing and is reported. SYNTHETIC values only; the key and the
 * passcode below are made up and are never printed by this test.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { merchantOsOpenUrl, openMerchantOsForTemp } from './merchantOsOpen'

const SYN_KEY = '0x' + 'a'.repeat(64)
const SYN_PASSCODE = 'SYN-PASSCODE-0001'
const SYN_TAG = '@synthetic.tag'

describe('merchantOsOpenUrl: the link has the BeamioTag only', () => {
	it('builds the Business OS link from the tag, without a passcode, a key or a temp private key parameter', () => {
		const url = merchantOsOpenUrl(SYN_TAG)
		expect(url).toBe('https://biz.beamio.ca/biz/#/?tag=synthetic.tag')
		expect(url).not.toContain('pin=')
		expect(url).not.toContain('tempPk')
		expect(url).not.toContain('flow=')
	})

	it('keeps the flow only when it is asked for', () => {
		expect(merchantOsOpenUrl(SYN_TAG, 'business')).toBe('https://biz.beamio.ca/biz/#/?tag=synthetic.tag&flow=business')
	})
})

describe('openMerchantOsForTemp: one unlock attempt, no passcode and no key in what is opened', () => {
	it('a blocked shell unlocks nothing and opens nothing', async () => {
		const unlock = jest.fn(async () => SYN_KEY)
		const open = jest.fn(() => true)
		const r = await openMerchantOsForTemp({ beamioTag: SYN_TAG, blocked: true, unlock, open })
		expect(r).toEqual({ ok: false, reason: 'blocked' })
		expect(unlock).not.toHaveBeenCalled()
		expect(open).not.toHaveBeenCalled()
	})

	it('a failed unlock is tried once (no polling), opens nothing, and reports unlock_failed', async () => {
		const unlock = jest.fn(async () => null)
		const open = jest.fn(() => true)
		const r = await openMerchantOsForTemp({ beamioTag: SYN_TAG, blocked: false, unlock, open })
		expect(r).toEqual({ ok: false, reason: 'unlock_failed' })
		expect(unlock).toHaveBeenCalledTimes(1)
		expect(open).not.toHaveBeenCalled()
	})

	it('a successful unlock opens the tag-only link; neither the key nor the passcode appears in it', async () => {
		const unlock = jest.fn(async () => SYN_KEY)
		const open = jest.fn((_url: string) => true)
		const r = await openMerchantOsForTemp({ beamioTag: SYN_TAG, blocked: false, unlock, open })
		expect(r).toEqual({ ok: true })
		expect(open).toHaveBeenCalledTimes(1)
		const opened = open.mock.calls[0][0]
		expect(opened).toBe('https://biz.beamio.ca/biz/#/?tag=synthetic.tag')
		expect(opened).not.toContain(SYN_KEY.slice(2))
		expect(opened).not.toContain(SYN_KEY)
		expect(opened).not.toContain(SYN_PASSCODE)
		expect(opened).not.toContain('pin=')
		expect(opened).not.toContain('tempPk')
	})

	it('when the open call fails, the result says so', async () => {
		const r = await openMerchantOsForTemp({ beamioTag: SYN_TAG, blocked: false, unlock: async () => SYN_KEY, open: () => false })
		expect(r).toEqual({ ok: false, reason: 'open_failed' })
	})
})

describe('no temp private key or passcode is written into any link, and the owner handover is gone (source guard)', () => {
	const SRC = join(__dirname, '..')

	/** Non-test source files under src (fixtures and tests excluded). */
	function sourceFiles(dir: string, out: string[] = []): string[] {
		for (const name of readdirSync(dir)) {
			if (name === '__fixtures__' || name === 'node_modules') continue
			const full = join(dir, name)
			if (statSync(full).isDirectory()) sourceFiles(full, out)
			else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full)
		}
		return out
	}

	it('no non-test source contains the removed names (tempPk, the owner link builder, openHandoff, the pin link)', () => {
		const hits: string[] = []
		for (const f of sourceFiles(SRC)) {
			const text = readFileSync(f, 'utf8')
			for (const needle of ['tempPk', 'buildAgentCardClaimUrl', 'openHandoff', 'merchantOsUnlockUrl']) {
				if (text.includes(needle)) hits.push(`${relative(SRC, f)}: ${needle}`)
			}
		}
		expect(hits).toEqual([])
	})

	it('the Business OS entry in the temp-account view opens no link with the passcode (pin) in it', () => {
		const text = readFileSync(join(SRC, 'pages', 'BountyBoard', 'AgentTempAccountStates.tsx'), 'utf8')
		expect(text).not.toContain('pin:')
		expect(text).not.toContain('while (Date.now() < deadline)')
		expect(text).toContain('openMerchantOsForTemp({')
	})

	it('the unified failure copy exists in both locales', () => {
		for (const f of ['en.json', 'zh-CN.json']) {
			// The locale files nest the keys, so the key is looked up at any depth.
			const found: string[] = []
			const walk = (node: unknown): void => {
				if (node && typeof node === 'object') {
					for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
						if (k === 'merchant_os_open_failed' && typeof v === 'string' && v.length > 0) found.push(v)
						walk(v)
					}
				}
			}
			walk(JSON.parse(readFileSync(join(SRC, 'locale', f), 'utf8')))
			expect(found).toHaveLength(1)
		}
	})
})
