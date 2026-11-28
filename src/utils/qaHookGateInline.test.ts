/**
 * @jest-environment node
 */
// every gate of the test hooks is the INLINE compile-time test `process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true'`. DefinePlugin turns it into `"false" === 'true'`, the minifier folds it and the
// branch, the import and the strings are gone from a production bundle. The cross-module constant (`const u=!1` ... `if(u&&...)`) is NOT folded: the hook code stayed in the product bundle, switched off. So no production source may
// read the constant `QA_ACK_ORDER_HOOK` (only its definition in qaAckOrder.ts may name it), and the build must have no other module-level copy of the switch. SYNTHETIC: it reads the sources.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')
function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) {
			if (name === 'node_modules' || name === '__fixtures__') continue
			walk(p, out)
		} else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
	}
	return out
}
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const files = walk(SRC)

describe('the test-hook gates are inline (production bundles fold them away)', () => {
	it('no production source except the definition in qaAckOrder.ts names the constant QA_ACK_ORDER_HOOK', () => {
		const offenders: string[] = []
		for (const f of files) {
			const hits = code(readFileSync(f, 'utf8')).match(/(?<![A-Za-z_.])QA_ACK_ORDER_HOOK(?![A-Za-z_])/g) ?? []
			const allowed = f.endsWith('utils/qaAckOrder.ts') ? 1 : 0
			if (hits.length !== allowed) offenders.push(`${f.slice(SRC.length + 1)}:${hits.length}`)
		}
		expect(offenders).toEqual([])
	})
	it('no module keeps its own module-level copy of the switch (a const that holds the env test and is read elsewhere in the file)', () => {
		const offenders: string[] = []
		for (const f of files) {
			const c = code(readFileSync(f, 'utf8'))
			for (const m of c.matchAll(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*process\.env\.REACT_APP_QA_ACK_ORDER_HOOK\s*===\s*'true'/gm)) {
				if (!(f.endsWith('utils/qaAckOrder.ts') && m[1] === 'QA_ACK_ORDER_HOOK')) offenders.push(`${f.slice(SRC.length + 1)}:${m[1]}`)
			}
		}
		expect(offenders).toEqual([])
	})
	it('the inline gate is used by every hook family: events, probes, counters, transport fault, copy source, plain cache, skip switch, switches in index.tsx', () => {
		const text = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
		for (const rel of ['App.tsx', 'pages/chat/chat.tsx', 'services/chatWorkerBridge.ts', 'services/chatPreheat.ts', 'services/chat.ts', 'index.tsx', 'utils/qaAckOrder.ts', 'services/deliveryReceiptBus.ts', 'services/historyRestoreApply.ts']) {
			expect({ rel, inline: /process\.env\.REACT_APP_QA_ACK_ORDER_HOOK (===|!==) 'true'/.test(code(text(rel))) }).toEqual({ rel, inline: true })
		}
	})
})
