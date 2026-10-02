import { HttpError } from './auth'
import { config } from './config'

/** Changes to the host are off in read-only mode. */
export function assertWritable() {
  if (config().readonly) throw new HttpError(403, 'Read-only-Modus: Aktionen sind deaktiviert (QUADECK_READONLY)')
}
