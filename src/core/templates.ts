import type { Db } from './store/db'
import type { MailTemplate } from '../shared/ipc'
import { htmlToText, sanitizeComposeHtml } from './mail/outgoing-html'

/** Šablóny správ: predmet a text na opakované použitie (vloží sa do okna správy). */

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

interface Row {
  id: number
  name: string
  subject: string
  html: string | null
  text: string
}

const toTemplate = (r: Row): MailTemplate => ({ id: r.id, name: r.name, subject: r.subject, html: r.html, text: r.text })

export function listTemplates(db: Db): MailTemplate[] {
  return (db.prepare('SELECT id, name, subject, html, text FROM templates ORDER BY name COLLATE NOCASE, id').all() as unknown as Row[]).map(toTemplate)
}

export function saveTemplate(db: Db, input: Partial<MailTemplate>): MailTemplate {
  const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 200) : ''
  if (!name) throw err('TEMPLATE_NAME', 'Zadajte názov šablóny')
  const subject = typeof input.subject === 'string' ? input.subject.slice(0, 1000) : ''
  // Formátovaný text sa prečistí rovnako ako koncept; textová podoba vznikne z neho.
  const html = typeof input.html === 'string' && input.html.trim() ? sanitizeComposeHtml(input.html) || null : null
  const text = html ? htmlToText(html) : typeof input.text === 'string' ? input.text.slice(0, 1_000_000) : ''
  if ((html?.length ?? 0) > 2_000_000) throw err('TEMPLATE_TOO_BIG', 'Šablóna je príliš veľká')
  if (Number.isInteger(input.id)) {
    const r = db
      .prepare(`UPDATE templates SET name = ?, subject = ?, html = ?, text = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? RETURNING *`)
      .get(name, subject, html, text, input.id as number) as unknown as Row | undefined
    if (!r) throw err('NOT_FOUND', 'Šablóna neexistuje')
    return toTemplate(r)
  }
  // Rovnaký názov = prepísať existujúcu šablónu (uloženie „znova“ z okna správy).
  const same = db.prepare('SELECT id FROM templates WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
  if (same) return saveTemplate(db, { ...input, id: same.id, name })
  return toTemplate(db.prepare('INSERT INTO templates (name, subject, html, text) VALUES (?, ?, ?, ?) RETURNING *').get(name, subject, html, text) as unknown as Row)
}

export function deleteTemplate(db: Db, id: number): void {
  db.prepare('DELETE FROM templates WHERE id = ?').run(id)
}
