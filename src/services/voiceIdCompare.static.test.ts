/**
 * -2 and: call and session ids are compared with sameCallId, never with === or !==. A call or session id is any name
 * that contains "callid" or "sessionid" in any letter case (for example callId, connectedCallId, liveCallId, receiveSessionId), and an
 * operand may be an expression (for example `(a?.callId || '')`). Both sides of sameCallId are non-empty and exactly equal,
 * so two empty ids never match.
 *
 * The check reads the TypeScript syntax tree of chat.tsx and App.tsx and flags every equality (=== !== == !=) with such a name anywhere
 * in either operand. A `typeof` operand is a type check, not an id comparison, and is not flagged.
 *
 * Not covered: a comparison made through a switch statement, an indexed lookup (`row[k] === v`), or a name that does not contain
 * callid or sessionid (for example `ref.current === offer`), and any other file. Other files are listed in the commit message.
 */
import fs from 'fs'
import path from 'path'
import * as ts from 'typescript'

const ROOT = path.resolve(__dirname, '..', '..')
const FILES = ['src/pages/chat/chat.tsx', 'src/App.tsx']
const NAME = /callid|sessionid/i
const EQ = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])

/** True when the expression contains a name that is a call or session id (any case). */
function mentionsId(node: ts.Node): boolean {
	let hit = false
	const visit = (n: ts.Node): void => {
		if (hit) return
		if (ts.isIdentifier(n) && NAME.test(n.text)) hit = true
		else if (ts.isPropertyAccessExpression(n) && NAME.test(n.name.text)) hit = true
		else ts.forEachChild(n, visit)
	}
	visit(node)
	return hit
}

/** Lines (1-based) of raw id comparisons in the syntax tree of one source text. */
export function rawIdComparisonLines(text: string, fileName = 'probe.tsx'): number[] {
	const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
	const lines: number[] = []
	const visit = (node: ts.Node): void => {
		if (ts.isBinaryExpression(node) && EQ.has(node.operatorToken.kind)) {
			const typeCheck = ts.isTypeOfExpression(node.left) || ts.isTypeOfExpression(node.right)
			if (!typeCheck && (mentionsId(node.left) || mentionsId(node.right))) {
				lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(sf)
	return lines
}

describe('-2 / : call and session ids are compared with sameCallId', () => {
	it.each(FILES)('%s has no raw === or !== on a name that contains callid or sessionid', (rel) => {
		const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
		expect(rawIdComparisonLines(text, rel)).toEqual([])
	})

	it('the check flags the forms the audit found, and not sameCallId or typeof checks (self-test)', () => {
		const probe = [
			"const a = (x?.callId || '') !== callId", // 1: expression operand
			'const b = connectedCallId === y', // 2: name with a prefix
			'const c = voiceReceiveSessionRef.current !== receiveSessionId', // 3: session id name
			"const d = x.callId === ''", // 4: literal, still an id comparison
			'const e = sameCallId(x.callId, y.callId)', // 5: the right form
			"const f = typeof signal.callId === 'string'", // 6: type check
			'const g = remoteEndHandledRef.current === liveCallId', // 7: remote end
		].join('\n')
		expect(rawIdComparisonLines(probe)).toEqual([1, 2, 3, 4, 7])
	})
})
