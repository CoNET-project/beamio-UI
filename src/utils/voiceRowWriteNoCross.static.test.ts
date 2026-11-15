/**
 * a call row never takes one id's value for the other, and call ids are compared exactly.
 *
 * The check reads the TypeScript syntax tree of every non-test source file under src/ (no regular expressions over the text).
 * Names are resolved with the TypeScript type checker (one single-file program per file): a name means the declaration it refers
 * to in its own scope, never another declaration that happens to share the name.
 *
 * 1. Literal rule. Every object literal property named callId or sessionId (plain, shorthand, string-keyed, or computed with a
 *    constant name) and every assignment `x.callId = ...` / `x.sessionId = ...` is checked: its value must not read the other id.
 *    A value reads the names it contains. It follows a variable to its declaration(s) and to every assignment to it, a destructured
 *    name to its source, and a field of an object literal only to that field. A field read from a call result is read by its field
 *    name only. Listed control payloads (sent to the shell, not stored) and one name-only case are exempt, by file and text.
 * 2. Writer rule. The row argument of upsertPhoneCallRecord, mergePhoneCallRecord and replacePhoneCallInRows (called directly, as a
 *    property, through a parenthesised comma, or as upsertPhoneCallRecordRef.current) is followed to its declaration(s). It must be
 *    an object literal, a logical or conditional choice of allowed values, a named helper that returns rows, or a stored record read
 *    back. Anything else fails: a parameter, an unlisted call, an unlisted name, or a computed key that cannot be resolved.
 * 3. Value rule. The writers are only called. Passing one on, copying it, aliasing it, renaming it in an import or export, or using it
 * as a callback fails. The ref may hold a writer only through useRef, an assignment to its .current, a call of .current, or a
 *    hook dependency list.
 *
 * Not covered (listed for the commit message): a field read from a call result is checked by field name only, and the body of that
 * call is not followed (an object literal inside it is still checked on its own); a parameter, or a name from another file, used as
 * an id value is checked by its name only; a row literal's spread source is not followed (only the literal's own callId and
 * sessionId properties are checked); a computed key that is not a constant string is checked only in a row argument of a writer; a
 * dynamic element write `row[k] = v` is not checked; only the three writers named above are checked (direct array writes, such as
 * a push onto phoneCalls, are not); a parameter default is not followed.
 *
 * The self-tests below prove that each bypass class is flagged and that the common non-bypass forms are not.
 */
import fs from 'fs'
import path from 'path'
import * as ts from 'typescript'

const SRC = path.resolve(__dirname, '..')

/** The row argument of each writer, by name. A Map, so that inherited names such as toString are never writers. */
const WRITERS = new Map<string, number>([
	['upsertPhoneCallRecord', 0],
	['mergePhoneCallRecord', 1],
	['replacePhoneCallInRows', 1],
])
const REF_NAME = 'upsertPhoneCallRecordRef'
const REF_CALL = 'upsertPhoneCallRecordRef.current'

/** Named helpers allowed to produce a row argument. Each one builds or looks up rows whose ids are checked where they are built. */
const DERIVED_OK = new Map<string, string>([
	['mergePhoneCallRecord', 'normalises the ids (storedRow) and takes its inputs from checked literals or stored rows'],
	['withSettledIncomingOutcome', 'changes the status of a merged row only'],
	['findPhoneCallByIds', 'returns a stored row found by its ids'],
	['findLiveCall', 'returns a stored row (a local helper that returns findPhoneCallByIds)'],
])

/** Non-call leaves allowed as row arguments, by exact text, with the reason. */
const OTHER_OK = new Map<string, string>([
	['(JSON.parse(entry.body) as ChatMessage)?.callRecord', 'a call record saved in a chat message, read back as stored'],
	['message.callRecord', 'a call record already stored on a chat message (dedupe merge)'],
	['for-of over currentChatCalls', 'an element of currentChatCalls, the stored call rows (profile phoneCalls) filtered by peer'],
])

/** Literals with both ids that are control payloads (not rows); their fallbacks are kept on purpose. */
const CONTROL_PAYLOADS: Array<{ file: string; text: string; reason: string }> = [
	{ file: 'pages/chat/chat.tsx', text: 'otherCallId || otherSessionId', reason: 'endSystemCall control payload' },
	{ file: 'pages/chat/chat.tsx', text: 'otherSessionId || otherCallId', reason: 'endSystemCall control payload' },
	{ file: 'pages/chat/chat.tsx', text: 'upsertCallId || upsertId', reason: 'endSystemCall control payload' },
	{ file: 'pages/chat/chat.tsx', text: 'upsertSessionId || upsertId', reason: 'endSystemCall control payload' },
	{ file: 'utils/voiceCallSession.ts', text: 'nativeCallId || nativeSessionId', reason: 'native call control payload' },
]

/** Name-only exemptions: the value reads no session field, but its name contains "SessionId". Keyed by file and text. */
const NAME_ONLY_OK: Array<{ file: string; text: string; reason: string }> = [
	{
		file: 'services/voiceCallController.ts',
		text: 'randomMailboxVoiceSessionId()',
		reason: 'returns 16 fresh random bytes as hex (utils/voiceCallSession.ts); it reads no session field',
	},
]

type Leaf = { kind: 'literal' } | { kind: 'param' } | { kind: 'call'; callee: string } | { kind: 'other'; text: string }
type WriterLeaf = { callee: string; line: number; leaf: Leaf }
type ScanResult = { literalFindings: string[]; writerLeaves: WriterLeaf[]; valueFindings: string[] }

const isAssignmentOperator = (k: ts.SyntaxKind): boolean => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment

const isStringLike = (e: ts.Node): e is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
	ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)

/** Strips parentheses, type assertions, non-null, await and satisfies; a comma expression gives its last operand. */
function valueOf(node: ts.Expression): ts.Expression {
	let e = node
	for (;;) {
		if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e) || ts.isSatisfiesExpression(e)) {
			e = e.expression
		} else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) {
			e = e.right
		} else {
			return e
		}
	}
}

/** The outermost expression a node is used as: climbs parentheses, assertions and a comma's last operand. */
function usedAs(node: ts.Node): ts.Node {
	let cur = node
	for (;;) {
		const p = cur.parent
		if (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p))) cur = p
		else if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.CommaToken && p.right === cur) cur = p
		else return cur
	}
}

/** A name that reads the other call id: for callId, a session or upsertId name; for sessionId, a callId or upsertId name. */
const readsOtherId = (field: 'callid' | 'sessionid', name: string): boolean =>
	field === 'callid' ? /session|upsertid/i.test(name) : /callid|upsertid/i.test(name)

/** Problems of the writer rule: a leaf that is not an allowed row. */
function leafProblems(leaves: WriterLeaf[], file: string): string[] {
	return leaves.flatMap(({ callee, line, leaf }): string[] => {
		const where = `${file}:${line} ${callee}`
		if (leaf.kind === 'literal') return []
		if (leaf.kind === 'call') return DERIVED_OK.has(leaf.callee) ? [] : [`${where} takes a row from ${leaf.callee}()`]
		if (leaf.kind === 'param') return [`${where} takes a row from a parameter`]
		return OTHER_OK.has(leaf.text) ? [] : [`${where} takes an unresolved value: ${leaf.text}`]
	})
}

/** Scans one source text. */
function scanSource(fileName: string, text: string): ScanResult {
	const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
	const host: ts.CompilerHost = {
		getSourceFile: (name) => (name === fileName ? sf : undefined),
		getDefaultLibFileName: () => 'lib.d.ts',
		writeFile: () => undefined,
		getCurrentDirectory: () => '/',
		getCanonicalFileName: (f) => f,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
		fileExists: (f) => f === fileName,
		readFile: () => undefined,
		getDirectories: () => [],
	}
	const program = ts.createProgram({
		rootNames: [fileName],
		options: { noLib: true, noResolve: true, noEmit: true, allowJs: false, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest },
		host,
	})
	const checker = program.getTypeChecker()
	const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
	const txt = (n: ts.Node): string => n.getText(sf)

	/** The symbol an identifier refers to; for a shorthand property, the variable its value comes from. */
	const symOfRef = (id: ts.Identifier): ts.Symbol | undefined => {
		if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) return checker.getShorthandAssignmentValueSymbol(id.parent)
		return checker.getSymbolAtLocation(id)
	}

	/** Every value assigned to a symbol by `x = v`, `x += v` and the other assignment operators. */
	const assigned = new Map<ts.Symbol, ts.Expression[]>()
	const collectAssignments = (n: ts.Node): void => {
		if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind) && ts.isIdentifier(n.left)) {
			const sym = checker.getSymbolAtLocation(n.left)
			if (sym) assigned.set(sym, [...(assigned.get(sym) ?? []), n.right])
		}
		ts.forEachChild(n, collectAssignments)
	}
	collectAssignments(sf)

	type Sources = { exprs: ts.Expression[]; forOf: ts.Expression[]; names: string[]; param: boolean; opaque: boolean }
	/** Where a referenced name gets its value: initialisers, assignments, loop collections and destructuring. */
	const sourcesOf = (id: ts.Identifier): Sources => {
		const out: Sources = { exprs: [], forOf: [], names: [], param: false, opaque: false }
		const sym = symOfRef(id)
		if (!sym) {
			out.opaque = true
			return out
		}
		for (const d of sym.declarations ?? []) {
			if (ts.isVariableDeclaration(d)) {
				if (d.initializer) {
					out.exprs.push(d.initializer)
				} else {
					const loop = d.parent.parent
					if (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) out.forOf.push(loop.expression)
					else out.opaque = true
				}
			} else if (ts.isBindingElement(d)) {
				// `const { sessionId: sid } = signal`: sid holds signal.sessionId, read by that name.
				const decl = d.parent.parent
				if (ts.isVariableDeclaration(decl) && decl.initializer && !lookupValue(decl.initializer, new Set())) {
					out.exprs.push(decl.initializer)
				}
				const prop = d.propertyName ?? d.name
				if (ts.isIdentifier(prop) || isStringLike(prop)) out.names.push(prop.text.toLowerCase())
				out.opaque = true
			} else if (ts.isParameter(d)) {
				out.param = true
			} else {
				out.opaque = true
			}
		}
		out.exprs.push(...(assigned.get(sym) ?? []))
		return out
	}

	/** True when a value is a call result (a lookup), directly or through variables, `||`, `??`, `&&` or a conditional. */
	const lookupValue = (x: ts.Expression, seen: Set<ts.Symbol>): boolean => {
		const e = valueOf(x)
		if (ts.isCallExpression(e)) return true
		if (ts.isIdentifier(e)) {
			const sym = symOfRef(e)
			if (sym && seen.has(sym)) return false
			const next = new Set(seen)
			if (sym) next.add(sym)
			const s = sourcesOf(e)
			return [...s.exprs, ...s.forOf].some((y) => lookupValue(y, next))
		}
		if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
			return lookupValue(e.left, seen) || lookupValue(e.right, seen)
		}
		if (ts.isConditionalExpression(e)) return lookupValue(e.whenTrue, seen) || lookupValue(e.whenFalse, seen)
		return false
	}

	/** The key of a property name; null when a computed key cannot be resolved to a constant string. */
	const keyOf = (name: ts.PropertyName): string | null => {
		if (ts.isIdentifier(name) || isStringLike(name) || ts.isNumericLiteral(name)) return name.text.toLowerCase()
		if (ts.isComputedPropertyName(name)) {
			const e = valueOf(name.expression)
			if (isStringLike(e)) return e.text.toLowerCase()
			if (ts.isIdentifier(e)) {
				const s = sourcesOf(e)
				const only = s.exprs.length === 1 && !s.opaque && !s.param && s.forOf.length === 0 ? valueOf(s.exprs[0]) : undefined
				if (only && isStringLike(only)) return only.text.toLowerCase()
			}
			return null
		}
		return ''
	}

	const literalFindings: string[] = []
	const writerLeaves: WriterLeaf[] = []
	const valueFindings: string[] = []

	/** The leaves of a writer's row argument. */
	const leavesOf = (node: ts.Expression, seen: Set<ts.Symbol>): Leaf[] => {
		const e = valueOf(node)
		if (ts.isObjectLiteralExpression(e)) {
			const unresolved = e.properties.some((p) => !ts.isSpreadAssignment(p) && ts.isComputedPropertyName(p.name) && keyOf(p.name) === null)
			return [unresolved ? { kind: 'other', text: '<computed key> ' + txt(e).slice(0, 80) } : { kind: 'literal' }]
		}
		if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) {
			return [...leavesOf(e.left, seen), ...leavesOf(e.right, seen)]
		}
		if (ts.isConditionalExpression(e)) return [...leavesOf(e.whenTrue, seen), ...leavesOf(e.whenFalse, seen)]
		if (ts.isIdentifier(e)) {
			const sym = symOfRef(e)
			if (sym && seen.has(sym)) return []
			const next = new Set(seen)
			if (sym) next.add(sym)
			const s = sourcesOf(e)
			const out: Leaf[] = []
			for (const x of s.exprs) out.push(...leavesOf(x, next))
			if (s.param) out.push({ kind: 'param' })
			for (const f of s.forOf) out.push({ kind: 'other', text: 'for-of over ' + txt(f) })
			if (s.opaque) out.push({ kind: 'other', text: e.text })
			return out
		}
		if (ts.isCallExpression(e)) return [{ kind: 'call', callee: txt(valueOf(e.expression)) }]
		return [{ kind: 'other', text: txt(e) }]
	}

	/** The names a value reads, following variables (see the header). */
	const readsOf = (node: ts.Node, seen: Set<ts.Symbol>, out: Set<string>): void => {
		if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)) {
			readsOf(node.expression, seen, out)
			return
		}
		if (ts.isIdentifier(node)) {
			out.add(node.text)
			followSources(node, seen, out)
			return
		}
		if (ts.isShorthandPropertyAssignment(node)) {
			out.add(node.name.text.toLowerCase())
			followSources(node.name, seen, out)
			return
		}
		if (ts.isPropertyAssignment(node)) {
			const k = keyOf(node.name)
			if (k) out.add(k)
			readsOf(node.initializer, seen, out)
			return
		}
		if (ts.isPropertyAccessExpression(node)) {
			const name = node.name.text.toLowerCase()
			out.add(name)
			readsBase(node.expression, name, seen, out)
			return
		}
		if (ts.isElementAccessExpression(node)) {
			const arg = valueOf(node.argumentExpression)
			if (isStringLike(arg)) {
				out.add(arg.text.toLowerCase())
				readsBase(node.expression, arg.text.toLowerCase(), seen, out)
			} else {
				readsOf(arg, seen, out)
				readsBase(node.expression, null, seen, out)
			}
			return
		}
		if (ts.isCallExpression(node)) {
			const callee = valueOf(node.expression)
			if (ts.isIdentifier(callee)) {
				out.add(callee.text.toLowerCase())
			} else if (ts.isPropertyAccessExpression(callee)) {
				out.add(callee.name.text.toLowerCase())
				readsBase(callee.expression, null, seen, out)
			} else {
				readsOf(callee, seen, out)
			}
			for (const a of node.arguments) readsOf(a, seen, out)
			return
		}
		ts.forEachChild(node, (c) => {
			readsOf(c, seen, out)
		})
	}

	const followSources = (id: ts.Identifier, seen: Set<ts.Symbol>, out: Set<string>): void => {
		const sym = symOfRef(id)
		if (sym && seen.has(sym)) return
		const next = new Set(seen)
		if (sym) next.add(sym)
		const s = sourcesOf(id)
		for (const n of s.names) out.add(n)
		for (const x of [...s.exprs, ...s.forOf]) readsOf(x, next, out)
	}

	/** A field read from a base: an object literal gives only that property; a call result gives only the field name. */
	const readsBase = (base: ts.Expression, prop: string | null, seen: Set<ts.Symbol>, out: Set<string>): void => {
		const b = valueOf(base)
		if (ts.isIdentifier(b)) {
			for (const x of sourcesOf(b).exprs) {
				const xe = valueOf(x)
				if (ts.isObjectLiteralExpression(xe)) {
					if (prop === null) continue
					for (const p of xe.properties) {
						if (ts.isPropertyAssignment(p) && keyOf(p.name) === prop) readsOf(p.initializer, seen, out)
						if (ts.isShorthandPropertyAssignment(p) && p.name.text.toLowerCase() === prop) readsOf(p.name, seen, out)
					}
				} else if (!lookupValue(x, seen)) {
					readsOf(x, seen, out)
				}
			}
			return
		}
		if (ts.isCallExpression(b)) return
		readsOf(b, seen, out)
	}

	/** Literal rule for one id field: the value must not read the other id. */
	const checkField = (node: ts.Node, key: string | null, value: ts.Node): void => {
		if (key !== 'callid' && key !== 'sessionid') return
		const reads = new Set<string>()
		readsOf(value, new Set(), reads)
		if ([...reads].some((r) => readsOtherId(key, r))) literalFindings.push(`${fileName}:${line(node)} ${key}: ${txt(value)}`)
	}

	/** Writer rule: the row-argument index when a call is a writer, by name, property or ref. */
	const writerIndexOf = (callee: ts.Expression): number | undefined => {
		const c = valueOf(callee)
		if (txt(c) === REF_CALL) return 0
		if (ts.isIdentifier(c)) return WRITERS.get(c.text)
		if (ts.isPropertyAccessExpression(c)) return WRITERS.get(c.name.text)
		return undefined
	}

	const isRefCurrent = (e: ts.Node): boolean =>
		ts.isPropertyAccessExpression(e) && e.name.text === 'current' && ts.isIdentifier(e.expression) && e.expression.text === REF_NAME

	/** Value rule: a writer may only be called, passed to useRef, assigned to the ref's .current, or listed as a hook dependency. */
	const checkWriterValue = (node: ts.Identifier | ts.PropertyAccessExpression): void => {
		const top = usedAs(node)
		const p = top.parent
		const isCallee = !!p && ts.isCallExpression(p) && p.expression === top
		const isUseRefArg = !!p && ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'useRef' &&
			p.arguments.some((a) => a === top)
		const isRefAssigned = !!p && ts.isBinaryExpression(p) && p.right === top && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && isRefCurrent(p.left)
		const isHookDeps = !!p && ts.isArrayLiteralExpression(p) && p.elements.some((a) => a === top) && ts.isCallExpression(p.parent) &&
			ts.isIdentifier(p.parent.expression) && /^use(Callback|Effect|Memo|LayoutEffect|ImperativeHandle)$/.test(p.parent.expression.text) &&
			p.parent.arguments[p.parent.arguments.length - 1] === p
		if (!(isCallee || isUseRefArg || isRefAssigned || isHookDeps)) {
			valueFindings.push(`${fileName}:${line(node)} writer used as a value: ${txt(node)}`)
		}
	}

	/** The ref name may only appear as `ref.current` or as the target of `ref.current = ...`. */
	const checkRefValue = (id: ts.Identifier): void => {
		const pa = id.parent
		const ok = ts.isPropertyAccessExpression(pa) && pa.expression === id && pa.name.text === 'current' && (
			(ts.isCallExpression(pa.parent) && pa.parent.expression === pa) ||
			(ts.isBinaryExpression(pa.parent) && pa.parent.left === pa && pa.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken))
		if (!ok) valueFindings.push(`${fileName}:${line(id)} ref used other than as .current(...) or an assignment target: ${txt(usedAs(id))}`)
	}

	/** Names declared here, and import and export specifiers (aliasing is checked on the specifier itself). */
	const isDeclarationName = (n: ts.Identifier): boolean => {
		const p = n.parent
		if (!p) return false
		if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return true
		return (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p) ||
			ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isClassDeclaration(p)) && p.name === n
	}

	const visit = (n: ts.Node): void => {
		// Literal rule: the id properties of object literals.
		if (ts.isObjectLiteralExpression(n)) {
			for (const p of n.properties) {
				if (ts.isPropertyAssignment(p)) checkField(p, keyOf(p.name), p.initializer)
				else if (ts.isShorthandPropertyAssignment(p)) checkField(p, p.name.text.toLowerCase(), p.name)
			}
		}
		// Literal rule: assignments to a property named callId or sessionId.
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			const l = n.left
			let key: string | null = null
			if (ts.isPropertyAccessExpression(l)) key = l.name.text.toLowerCase()
			else if (ts.isElementAccessExpression(l)) {
				const a = valueOf(l.argumentExpression)
				if (isStringLike(a)) key = a.text.toLowerCase()
			}
			checkField(n, key, n.right)
		}
		// Writer rule: calls of a writer.
		if (ts.isCallExpression(n)) {
			const idx = writerIndexOf(n.expression)
			if (idx !== undefined) {
				const callee = txt(n.expression)
				const arg = n.arguments[idx] as ts.Expression | undefined
				if (!arg) writerLeaves.push({ callee, line: line(n), leaf: { kind: 'other', text: '<missing argument>' } })
				else for (const leaf of leavesOf(arg, new Set())) writerLeaves.push({ callee, line: line(n), leaf })
			}
		}
		// Value rule: a writer or the ref used other than as a call.
		if (ts.isPropertyAccessExpression(n) && WRITERS.has(n.name.text)) checkWriterValue(n)
		if (ts.isIdentifier(n) && !isDeclarationName(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
			if (n.text === REF_NAME) checkRefValue(n)
			else if (WRITERS.has(n.text)) checkWriterValue(n)
		}
		// Value rule: a writer imported or exported under another name.
		if (ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) {
			const original = n.propertyName
			if (original && ts.isIdentifier(original) && WRITERS.has(original.text)) {
				valueFindings.push(`${fileName}:${line(n)} writer renamed in an import or export: ${txt(n)}`)
			}
		}
		ts.forEachChild(n, visit)
	}

	visit(sf)
	return { literalFindings, writerLeaves, valueFindings }
}

function walk(dir: string, out: string[] = []): string[] {
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name)
		if (fs.statSync(full).isDirectory()) {
			if (name === '__fixtures__' || name === 'node_modules') continue
			walk(full, out)
		} else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
			out.push(full)
		}
	}
	return out
}

describe('call rows never take one id for the other, and call ids are compared exactly', () => {
	const files = walk(SRC).map((f) => ({ rel: path.relative(SRC, f), text: fs.readFileSync(f, 'utf8') }))
	const scanned = files.map((f) => ({ rel: f.rel, scan: scanSource(f.rel, f.text) }))
	const exempt = (file: string, text: string): boolean =>
		CONTROL_PAYLOADS.some((c) => c.file === file && c.text === text) || NAME_ONLY_OK.some((c) => c.file === file && c.text === text)

	it('literal rule: every callId or sessionId property and assignment reads only its own id, except the listed exemptions', () => {
		const unlisted = scanned.flatMap((s) => s.scan.literalFindings.filter((finding) => {
			const text = finding.slice(finding.indexOf(': ') + 2)
			return !exempt(s.rel, text)
		}))
		expect(unlisted).toEqual([])
	})

	it('writer rule: every row argument of upsertPhoneCallRecord, mergePhoneCallRecord and replacePhoneCallInRows resolves to an allowed value', () => {
		const problems = scanned.flatMap((s) => leafProblems(s.scan.writerLeaves, s.rel))
		expect(problems).toEqual([])
	})

	it('value rule: the writers are only called (not passed on, copied, aliased, renamed or used as callbacks)', () => {
		const problems = scanned.flatMap((s) => s.scan.valueFindings)
		expect(problems).toEqual([])
	})

	it('the scan covers the call-row writers in App.tsx and chat.tsx (not zero)', () => {
		const leaves = scanned.filter((s) => s.rel === 'App.tsx' || s.rel === path.join('pages', 'chat', 'chat.tsx'))
			.flatMap((s) => s.scan.writerLeaves)
		expect(leaves.length).toBeGreaterThan(10)
	})

	describe('self-test: each bypass class is flagged', () => {
		const flagged = (code: string): number => {
			const s = scanSource('x.ts', code)
			return s.literalFindings.length + s.valueFindings.length + leafProblems(s.writerLeaves, 'x.ts').length
		}
		const cases: Array<[string, string]> = [
			['a single-sided literal', 'upsertPhoneCallRecord({ callId: signal.sessionId, status: "missed" })'],
			['a literal with a spread', 'upsertPhoneCallRecord({ ...prev, callId: signal.sessionId, status: "missed" })'],
			['a computed string key', 'upsertPhoneCallRecord({ ["callId"]: signal.sessionId, sessionId: sid })'],
			['a computed key from a constant', 'const K = "callId"; upsertPhoneCallRecord({ [K]: signal.sessionId, sessionId: sid })'],
			['a string-literal element access', 'upsertPhoneCallRecord({ callId: signal["sessionId"], sessionId: sid })'],
			['a shorthand property', 'const callId = signal.sessionId; upsertPhoneCallRecord({ callId, sessionId })'],
			['a neutral variable name', 'const sid = signal.sessionId; upsertPhoneCallRecord({ callId: sid, sessionId: x })'],
			['a called function name', 'upsertPhoneCallRecord({ callId: sessionIdOf(signal), sessionId: sid })'],
			['a reassigned row', 'let row = { callId: "a", sessionId: "b" }; row = buildRow(sig); upsertPhoneCallRecord(row)'],
			['a reassigned id', 'let cid = "c"; cid = signal.sessionId; upsertPhoneCallRecord({ callId: cid, sessionId: "s" })'],
			['an alias of a writer', 'const up = upsertPhoneCallRecord; up(buildRow())'],
			['a comma-parenthesised writer call', '(0, mergePhoneCallRecord)(cur, build())'],
			['a writer called as a property of another object', 'api.upsertPhoneCallRecord(build())'],
			['a parameter that shares a name with a row elsewhere', 'const row = { callId: "a", sessionId: "b" }; function f(row) { upsertPhoneCallRecord(row) }'],
			['a destructured name', 'const { sessionId: sid } = signal; upsertPhoneCallRecord({ callId: sid, sessionId: "s" })'],
			['a property assignment', 'row.sessionId = signal.callId'],
			['an inherited name as a row', 'upsertPhoneCallRecord(toString())'],
			['a writer passed as a callback', '[1].map(upsertPhoneCallRecord)'],
			['a writer imported under another name', 'import { upsertPhoneCallRecord as up } from "./x"'],
			['a row literal with an unresolvable computed key', 'upsertPhoneCallRecord({ [k]: v, status: "x" })'],
		]
		it.each(cases)('%s', (_label, code) => {
			expect(flagged(code)).toBeGreaterThan(0)
		})
	})

	describe('self-test: the common forms are not flagged', () => {
		const clean = (code: string): void => {
			const s = scanSource('x.ts', code)
			expect(s.literalFindings).toEqual([])
			expect(s.valueFindings).toEqual([])
			expect(leafProblems(s.writerLeaves, 'x.ts')).toEqual([])
		}
		it('shorthand from literal values, and a call whose name holds no id', () => {
			clean('const callId = "c"; const sessionId = "s"; upsertPhoneCallRecord({ callId, sessionId })')
			clean('mergePhoneCallRecord(cur, { callId: makeId(), sessionId: "s" })')
		})
		it('a field of a looked-up row is read by its field name, not through the lookup itself', () => {
			clean('const existing = rows.find(r => r.sessionId === sid); upsertPhoneCallRecord({ callId: existing?.callId || "x", sessionId: sid })')
		})
		it('a writer in a hook dependency list, and a writer held in a ref and called through .current', () => {
			clean('const cb = useCallback(() => upsertPhoneCallRecord({ callId: "a", sessionId: "b" }), [upsertPhoneCallRecord])')
			clean('const upsertPhoneCallRecordRef = useRef(upsertPhoneCallRecord); upsertPhoneCallRecordRef.current({ callId: "a", sessionId: "b" })')
		})
		it('a row built from a spread of a parameter, with no id property of its own', () => {
			clean('function f(patch) { return mergePhoneCallRecord(prev, { ...patch, createdAt: 1 }) }')
		})
	})
})
