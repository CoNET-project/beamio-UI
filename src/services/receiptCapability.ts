/**
 * The delivered-receipt path through the native module is used only when the native module says it supports it, at run time: the hello answer
 * lists the capability below. A shell that does not list it (an older shell) and the browser behave exactly as before: the page sends no
 * routes and runs its own receipt code. The same ZIP therefore runs safely on old and new shells; no build switch decides this.
 * The capability name (`receipt.delivery.v1`) is one constant. It is declared only by a native module that has the full receipt implementation (route table checks, loop guard, de-duplication, queue limits).
 */
import { getCachedHello } from './nativeChatRouteRegister'
import { isShellContext } from './shellContext'

export const RECEIPT_SENDER_CAPABILITY = 'receipt.delivery.v1'

/** Pure: does a hello answer declare the capability. */
export function receiptCapabilityDeclaredBy(hello: { capabilities?: readonly string[] } | null | undefined): boolean {
	return !!hello && Array.isArray(hello.capabilities) && hello.capabilities.includes(RECEIPT_SENDER_CAPABILITY)
}

/** A shell whose native module sends the delivered receipt itself: the page then gives it the routes and runs none of its own receipt code. */
export function nativeReceiptPath(): boolean {
	return isShellContext() && receiptCapabilityDeclaredBy(getCachedHello())
}
