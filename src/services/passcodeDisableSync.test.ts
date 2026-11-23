import { disablePasscodeThenSync, type DisablePasscodeSteps } from './passcodeDisableSync'

const EOA = '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f'
const PHRASE = 'fog spot notable regret pizza coffee harvest ensure fog spot notable reflect'

function steps(over: Partial<DisablePasscodeSteps> = {}) {
	const order: string[] = []
	const s: DisablePasscodeSteps = {
		verifyPasscode: async () => {
			order.push('verify')
			return PHRASE
		},
		writePlainAndReadBack: async () => {
			order.push('write')
			return true
		},
		replaceCipher: async () => {
			order.push('replace')
			return true
		},
		clearCooldown: async () => {
			order.push('clear')
		},
		syncPlain: () => {
			order.push('sync')
		},
		...over,
	}
	return { s, order }
}

describe('closing the passcode: the order is verify, write and read back, replace, clear, then one background sync', () => {
	it('the full path runs the steps in order and syncs the plain phrase exactly once, after the clear', async () => {
		const { s, order } = steps()
		expect(await disablePasscodeThenSync('482913', EOA, s)).toBe('disabled')
		expect(order).toEqual(['verify', 'write', 'replace', 'clear', 'sync'])
	})

	it('a wrong passcode writes nothing and syncs nothing', async () => {
		const { s, order } = steps({ verifyPasscode: async () => null })
		expect(await disablePasscodeThenSync('111111', EOA, s)).toBe('wrong_passcode')
		expect(order).toEqual([])
	})

	it('a write whose read-back does not match: no replace, no clear, no sync', async () => {
		const { s, order } = steps({ writePlainAndReadBack: async () => false })
		expect(await disablePasscodeThenSync('482913', EOA, s)).toBe('write_failed')
		expect(order).toEqual(['verify'])
	})

	it('a failed replace: no clear and no sync', async () => {
		const { s, order } = steps({ replaceCipher: async () => false })
		expect(await disablePasscodeThenSync('482913', EOA, s)).toBe('replace_failed')
		expect(order).toEqual(['verify', 'write'])
	})
})
