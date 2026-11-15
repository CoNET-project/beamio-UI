/**
 * The update prompt event: a refused build raises one event; listeners are removed when they unsubscribe.
 */
import { APP_UPDATE_REQUIRED_EVENT, notifyAppUpdateRequired, onAppUpdateRequired } from './appUpdatePrompt'

describe('the update prompt event', () => {
	it('one notification reaches each listener once; an unsubscribed listener is not called', () => {
		const a = jest.fn()
		const b = jest.fn()
		const offA = onAppUpdateRequired(a)
		onAppUpdateRequired(b)
		notifyAppUpdateRequired()
		expect(a).toHaveBeenCalledTimes(1)
		expect(b).toHaveBeenCalledTimes(1)
		offA()
		notifyAppUpdateRequired()
		expect(a).toHaveBeenCalledTimes(1)
		expect(b).toHaveBeenCalledTimes(2)
	})
	it('the event name is fixed', () => {
		expect(APP_UPDATE_REQUIRED_EVENT).toBe('beamioAppUpdateRequired')
	})
})
