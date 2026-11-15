/**
 * The shell identity source: only the public address is kept; a value that is not a canonical address is
 * never returned; the retry state notifies its listeners on change only. SYNTHETIC address.
 */
import { getShellIdentityPending, persistShellEoa, readPersistedShellEoa, setShellIdentityPending, subscribeShellIdentityPending } from './shellIdentitySource'

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const KEY = 'beamio.shellPublicEoa.v1'

afterEach(() => {
	window.localStorage.clear()
	setShellIdentityPending(false)
})

describe('persisted public EOA', () => {
	it('keeps the lower-case address only, and reads it back', () => {
		expect(persistShellEoa(EOA.toUpperCase().replace('0X', '0x'))).toBe(true)
		expect(window.localStorage.getItem(KEY)).toBe(EOA)
		expect(readPersistedShellEoa()).toBe(EOA)
	})

	it('a value that is not a canonical address is not kept', () => {
		expect(persistShellEoa('not-an-address')).toBe(false)
		expect(persistShellEoa('')).toBe(false)
		expect(window.localStorage.getItem(KEY)).toBeNull()
	})

	it('a stored value that is not a canonical address is never returned', () => {
		window.localStorage.setItem(KEY, '{"privateKey":"x"}')
		expect(readPersistedShellEoa()).toBe('')
	})

	it('nothing stored: empty', () => {
		expect(readPersistedShellEoa()).toBe('')
	})
})

describe('retry-later state', () => {
	it('notifies on change only', () => {
		const seen: boolean[] = []
		const off = subscribeShellIdentityPending((v) => seen.push(v))
		setShellIdentityPending(true)
		setShellIdentityPending(true)
		setShellIdentityPending(false)
		expect(seen).toEqual([true, false])
		expect(getShellIdentityPending()).toBe(false)
		off()
	})
})
