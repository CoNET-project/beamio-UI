import { homeAccountName, keepExistingAccountName } from './accountNameGuard'

describe('home capsule label (display only)', () => {
	it('uses the React state name when it is set', () => {
		expect(homeAccountName('alice', 'stored-name')).toBe('alice')
	})

	it('falls back to the stored wallet name while the state is not set yet (the observed @Beamio glitch)', () => {
		expect(homeAccountName(undefined, 'synthetic-e2e')).toBe('synthetic-e2e')
		expect(homeAccountName('', 'synthetic-e2e')).toBe('synthetic-e2e')
	})

	it('uses the product default only when no name exists anywhere', () => {
		expect(homeAccountName(undefined, undefined)).toBe('Beamio')
		expect(homeAccountName('  ', '')).toBe('Beamio')
	})

	it('strips a leading @ from the name', () => {
		expect(homeAccountName('@bob', undefined)).toBe('bob')
	})
})

describe('keeping an existing account name (save path, failed server call)', () => {
	it('keeps the existing name when the incoming update carries none', () => {
		// A failed server call returns the object without a usable name: the stored name must survive.
		expect(keepExistingAccountName('synthetic-e2e', '')).toBe('synthetic-e2e')
		expect(keepExistingAccountName('synthetic-e2e', undefined)).toBe('synthetic-e2e')
		expect(keepExistingAccountName('synthetic-e2e', '   ')).toBe('synthetic-e2e')
	})

	it('takes a new non-empty name (a deliberate change by the user)', () => {
		expect(keepExistingAccountName('synthetic-e2e', 'renamed')).toBe('renamed')
	})

	it('returns undefined only when neither side has a name', () => {
		expect(keepExistingAccountName(undefined, '')).toBeUndefined()
	})
})
