/** side-effect import: must come before any module that may request or render an address */
import { installRetiredHostGuard } from './retiredHostGuard'

installRetiredHostGuard()
