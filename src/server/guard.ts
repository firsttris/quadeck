import { HttpError } from './auth'
import { config } from './config'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

/** Changes to the host are off in read-only mode. */
export function assertWritable() {
  if (config().readonly) throw new HttpError(403, msg(m.hub_error_readonly))
}
