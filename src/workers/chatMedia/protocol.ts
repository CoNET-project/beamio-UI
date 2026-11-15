export type ChatMediaWorkerRequest = {
	type: 'decrypt-fragment'
	reqId: number
	body: Blob
	isText: boolean
	key: string
	iv: string
	unzip: boolean
}

export type ChatMediaWorkerResponse =
	| { type: 'ready' }
	| { type: 'decrypt-result'; reqId: number; ok: true; kind: 'plain'; plain: ArrayBuffer }
	| { type: 'decrypt-result'; reqId: number; ok: true; kind: 'files'; files: Record<string, ArrayBuffer> }
	| { type: 'decrypt-result'; reqId: number; ok: false; error: string }
