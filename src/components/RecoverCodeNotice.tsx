/**
 * Shows the recover code the native layer returned once after a new account was created (base58). The code is held by this component only
 * (React state of the caller): never written to a store or a log. The user confirms that it was saved before the page goes on.
 */
import { useState } from 'react'
import { tu } from '../locale/beamioLocale'

export default function RecoverCodeNotice({ code, onDone }: { code: string; onDone: () => void }) {
	const [saved, setSaved] = useState(false)
	return (
		<div role="dialog" aria-modal="true" data-testid="recover-code-notice" className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 px-6">
			<div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
				<h2 className="text-base font-semibold text-slate-900">{tu('create_account_recover_code_title')}</h2>
				<p className="mt-2 text-sm text-slate-700">{tu('create_account_recover_code_body')}</p>
				<p data-testid="recover-code" className="mt-3 select-all break-all rounded-lg bg-slate-100 p-3 font-mono text-sm text-slate-900">
					{code}
				</p>
				<label className="mt-3 flex items-center gap-2 text-sm text-slate-800">
					<input type="checkbox" data-testid="recover-code-saved" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} />
					<span>{tu('create_account_recover_code_confirm')}</span>
				</label>
				<button
					type="button"
					data-testid="recover-code-continue"
					disabled={!saved}
					onClick={onDone}
					className="mt-4 w-full rounded-full bg-[#2f80ed] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
				>
					{tu('continue')}
				</button>
			</div>
		</div>
	)
}
