/**
 * The central identity guard raises the shared prompt, and the gate mounts it once. Reads the sources.
 */
import fs from 'fs'
import path from 'path'

const guard = fs.readFileSync(path.join(__dirname, 'shellChatCapability.ts'), 'utf8')
const gate = fs.readFileSync(path.join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')

describe('the shared identity prompt is wired at the central guard and the gate', () => {
	it('shellChatBlockedNow raises the prompt when it blocks', () => {
		expect(guard).toContain("import { notifyIdentityEntryBlocked } from './identityEntryPrompt'")
		expect(guard).toContain('if (blocked) notifyIdentityEntryBlocked()')
	})

	it('the gate mounts the prompt once, outside the decided children', () => {
		expect(gate).toContain("import IdentityEntryPrompt from '@/components/IdentityEntryPrompt'")
		expect(gate.split('<IdentityEntryPrompt />').length - 1).toBe(1)
	})
})
