import { HttpError } from './auth'
import { config } from './config'
import { tr } from '~/shared/i18n'

/** Changes to the host are off in read-only mode. */
export function assertWritable() {
  if (config().readonly) throw new HttpError(403, tr('Read-only-Modus: Aktionen sind deaktiviert (QUADECK_READONLY)', 'Read-only mode: actions are disabled (QUADECK_READONLY)'))
}
