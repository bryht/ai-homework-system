import { getRegionName, type UserLocation } from '../location.js'
import { LOCALE } from '../settings.js'
import { formatDate } from '../../utils/format.js'
import { translate } from '../../i18n/index.js'

/** The five fields the model expects; date and weekday use the browser's time zone so they do not
 * roll over at UTC midnight. */
export const createLatestReminder = (
  { location }: { location: UserLocation | null },
  now = new Date()
): string => {
  return [
    formatDate(now),
    new Intl.DateTimeFormat(LOCALE, { weekday: 'long' }).format(now),
    location ? getRegionName(location.region) : '',
    'Web',
    translate('latestReminderLanguage'),
  ].join(',')
}
