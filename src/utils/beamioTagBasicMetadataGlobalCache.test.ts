/**
 * 2026-11-17 rule (#1, UN-04/05; account-select UN-04/05): BeamioTag keys keep the exact name; Alice and alice are two keys; a query
 * for alice does not hit Alice's cache; addresses stay case-insensitive. SYNTHETIC values only. Each case uses its own names because the
 * module keeps an in-memory map across cases.
 */
import { peekBeamioTagBasicMetadataForQuery, rememberBeamioTagBasicMetadata } from './beamioTagBasicMetadataGlobalCache'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const PREFIX = 'beamio:beamioTagBasicMeta:v1:'

const meta = (username: string, address: string) => ({
	username,
	address,
	image: '',
	first_name: '',
	last_name: '',
	created_at: 1,
	follow_count: '0',
	follower_count: '0',
})

describe('BeamioTag basic metadata cache: the tag index is case-sensitive (#1)', () => {
	it('Alice and alice at two addresses do not overwrite each other', () => {
		rememberBeamioTagBasicMetadata(meta('CaseA1', A))
		rememberBeamioTagBasicMetadata(meta('casea1', B))
		expect(peekBeamioTagBasicMetadataForQuery('CaseA1')?.address).toBe(A)
		expect(peekBeamioTagBasicMetadataForQuery('casea1')?.address).toBe(B)
	})

	it('a query for alice does not hit the cache of Alice (only Alice is cached)', () => {
		rememberBeamioTagBasicMetadata(meta('CaseA2', A))
		expect(peekBeamioTagBasicMetadataForQuery('caseA2')).toBeNull()
		expect(peekBeamioTagBasicMetadataForQuery('CaseA2')?.address).toBe(A)
	})

	it('the exact name hits, with or without a leading @ (the @ is not part of the name)', () => {
		rememberBeamioTagBasicMetadata(meta('CaseA3', A))
		expect(peekBeamioTagBasicMetadataForQuery('@CaseA3')?.address).toBe(A)
		expect(peekBeamioTagBasicMetadataForQuery('  CaseA3 ')?.address).toBe(A)
	})

	it('an old entry keyed in lower case for a name written in another case is a miss, and it is kept (not deleted or migrated)', () => {
		const oldKey = `${PREFIX}tag:caseold4`
		const raw = JSON.stringify({ v: 1, savedAt: 1, meta: meta('CaseOld4', A) })
		window.localStorage.setItem(oldKey, raw)
		expect(peekBeamioTagBasicMetadataForQuery('caseold4')).toBeNull()
		expect(window.localStorage.getItem(oldKey)).toBe(raw)
	})

	it('addresses stay case-insensitive: the checksum or lower case of an address hits the same entry', () => {
		rememberBeamioTagBasicMetadata(meta('CaseA5', A))
		expect(peekBeamioTagBasicMetadataForQuery(A.toUpperCase().replace('0X', '0x'))?.username).toBe('CaseA5')
		expect(peekBeamioTagBasicMetadataForQuery(A)?.username).toBe('CaseA5')
	})
})
