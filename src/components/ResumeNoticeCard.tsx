/**
 * 0.53.51: the one-time notice card of the resume-create route (see services/resumeNotice.ts). A card on the home, not a dialog:
 * it does not take focus, does not cover the app, and closes with its own button.
 */
import { useEffect, useState } from 'react'
import { tu } from '../locale/beamioLocale'
import { dismissResumeNotice, getResumeNotice, subscribeResumeNotice } from '../services/resumeNotice'

const COPY_KEY = {
	code_not_shown: 'create_account_code_not_shown_notice',
	already_registered_keep_password: 'create_account_already_registered_keep_password_notice',
} as const

export default function ResumeNoticeCard() {
	const [notice, setNotice] = useState(getResumeNotice())
	useEffect(() => {
		setNotice(getResumeNotice())
		return subscribeResumeNotice(() => setNotice(getResumeNotice()))
	}, [])
	if (!notice) return null
	return (
		<div data-testid="resume-notice-card" role="status" className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-[9000] flex justify-center px-4">
			<div className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-2xl bg-white p-4 text-sm text-slate-800 shadow-lg ring-1 ring-slate-200">
				<p data-testid="resume-notice-text" className="min-w-0 flex-1">{tu(COPY_KEY[notice.kind])}</p>
				<button type="button" data-testid="resume-notice-dismiss" className="shrink-0 rounded-full bg-[#1562f0] px-3 py-1 text-xs font-semibold text-white" onClick={() => dismissResumeNotice()}>
					{tu('ok')}
				</button>
			</div>
		</div>
	)
}
