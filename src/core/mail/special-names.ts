import type { SpecialUse } from '../../shared/ipc'

/**
 * Názvy, pod ktorými rôzne programy a webmaily zakladajú špeciálne priečinky (Outlook „Sent Items“,
 * „Deleted Items“, webmail „Trash“…). Na jednom serveri tak často vzniknú dva Koše či dve Odoslané.
 */
const NAMES: [SpecialUse, string[]][] = [
  ['sent', ['sent', 'sent items', 'sent messages', 'sent mail', 'odoslané', 'odoslaná pošta', 'odeslané', 'odeslaná pošta', 'gesendet', 'gesendete elemente', 'gesendete objekte']],
  ['trash', ['trash', 'deleted', 'deleted items', 'deleted messages', 'bin', 'kôš', 'koš', 'kos', 'odstránená pošta', 'odstraněná pošta', 'papierkorb', 'gelöschte elemente']],
  ['junk', ['junk', 'junk e-mail', 'junk email', 'junk mail', 'spam', 'bulk mail', 'nevyžiadaná pošta', 'nevyžádaná pošta']],
  ['drafts', ['drafts', 'draft', 'koncepty', 'entwürfe']],
  ['archive', ['archive', 'archives', 'archív', 'archiv']]
]

const BY_NAME = new Map<string, SpecialUse>(NAMES.flatMap(([use, names]) => names.map((n): [string, SpecialUse] => [n, use])))

/** Funkcia priečinka podľa názvu (len na najvyššej úrovni alebo priamo pod INBOX), inak null. */
export function specialByName(segments: string[]): SpecialUse | null {
  const top = segments.length === 2 && segments[0]!.toUpperCase() === 'INBOX' ? segments[1]! : segments.length === 1 ? segments[0]! : null
  return top ? (BY_NAME.get(top.trim().toLowerCase()) ?? null) : null
}
