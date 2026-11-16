import { deviceCachedBeamioTagFor, homeAccountName, homeDisplayLabel, keepExistingAccountName, rememberDeviceBeamioTag, shortAddressLabel } from './accountNameGuard'

const ADDR = '0x6411' + 'ab'.repeat(16) + '6Ec6'

describe('home capsule label (display only)', () => {
	it('uses the React state name when it is set', () => {
		expect(homeAccountName('alice', 'stored-name')).toBe('alice')
	})

	it('falls back to the stored wallet name while the state is not set yet (the observed @Beamio glitch)', () => {
		expect(homeAccountName(undefined, 'synthetic-e2e')).toBe('synthetic-e2e')
		expect(homeAccountName('', 'synthetic-e2e')).toBe('synthetic-e2e')
	})

	it('returns nothing when no name exists anywhere (never a fixed product name)', () => {
		expect(homeAccountName(undefined, undefined)).toBe('')
		expect(homeAccountName('  ', '')).toBe('')
	})

	it('uses the BeamioTag cached on this device when the state and the stored name are empty (offline)', () => {
		expect(homeAccountName(undefined, undefined, 'qa_s25_fini6')).toBe('qa_s25_fini6')
	})

	it('shows the short address as the neutral placeholder when no name is known', () => {
		expect(homeDisplayLabel('', ADDR)).toBe(shortAddressLabel(ADDR))
		expect(homeDisplayLabel('', ADDR)).not.toContain('Beamio')
	})

	it('shows nothing when neither a name nor an address is known', () => {
		expect(homeDisplayLabel('', undefined)).toBe('')
		expect(homeDisplayLabel('', 'not-an-address')).toBe('')
	})

	it('labels a known name with a single @', () => {
		expect(homeDisplayLabel('qa_s25_fini6', ADDR)).toBe('@qa_s25_fini6')
	})

	it('shortens a full address to the first six and last four characters', () => {
		expect(shortAddressLabel(ADDR)).toBe('0x6411…6Ec6')
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

describe('device-cached BeamioTag is bound to its EOA', () => {
	const EOA_A = '0x6411' + 'ab'.repeat(16) + '6Ec6'
	const EOA_B = '0x1111' + 'cd'.repeat(16) + '2222'
	afterEach(() => window.localStorage.clear())

	it('returns the cached name for the same account (case-insensitive EOA)', () => {
		rememberDeviceBeamioTag('@qa_s25_fini6', EOA_A)
		expect(deviceCachedBeamioTagFor(EOA_A)).toBe('qa_s25_fini6')
		expect(deviceCachedBeamioTagFor(EOA_A.toUpperCase().replace('0X', '0x'))).toBe('qa_s25_fini6')
	})

	it('never shows the cached name for a different account after a switch', () => {
		rememberDeviceBeamioTag('qa_s25_fini6', EOA_A)
		expect(deviceCachedBeamioTagFor(EOA_B)).toBe('')
	})

	it('a write without a valid EOA is ignored, so nothing unbound is cached', () => {
		rememberDeviceBeamioTag('orphan', undefined)
		rememberDeviceBeamioTag('orphan', 'not-an-eoa')
		expect(window.localStorage.getItem('beamio.shellAccountName')).toBeNull()
	})

	it('an entry in the earlier format (no EOA) is not used', () => {
		window.localStorage.setItem('beamio.shellAccountName', 'legacy_name')
		expect(deviceCachedBeamioTagFor(EOA_A)).toBe('')
	})

	it('is empty when nothing is cached or the EOA is missing', () => {
		expect(deviceCachedBeamioTagFor(EOA_A)).toBe('')
		rememberDeviceBeamioTag('qa_s25_fini6', EOA_A)
		expect(deviceCachedBeamioTagFor(undefined)).toBe('')
	})

	it('a new name for the same device replaces the old entry', () => {
		rememberDeviceBeamioTag('old_name', EOA_A)
		rememberDeviceBeamioTag('new_name', EOA_B)
		expect(deviceCachedBeamioTagFor(EOA_A)).toBe('')
		expect(deviceCachedBeamioTagFor(EOA_B)).toBe('new_name')
	})
})
