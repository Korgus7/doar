import type { Db } from './store/db'
import type { CoreEvents, EventChannel, MessageView } from '../shared/ipc'
import { renderMessage } from './mail/parse'
import { fetchRemoteImages } from './mail/remote'

/**
 * Správa pripravená na zobrazenie (spoločné pre poštu konta aj lokálny archív).
 * Vzdialený obsah sa načíta len na požiadanie alebo pre povoleného odosielateľa.
 */
export async function buildView(
  ctx: {
    db: Db
    fetchRemote?: (urls: string[], opts?: { onLate?: () => void }) => Promise<Map<string, string>>
    emit?<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
  },
  raw: Buffer,
  base: { id: number; accountId: number; subject: string; date: string | null; sender: string },
  opts: { showRemote?: boolean; alwaysForSender?: boolean } = {}
): Promise<MessageView> {
  const sender = base.sender.toLowerCase()
  if (opts.alwaysForSender && sender) ctx.db.prepare('INSERT OR IGNORE INTO remote_content_allow(sender) VALUES (?)').run(sender)
  const senderAllowed = !!sender && !!ctx.db.prepare('SELECT 1 FROM remote_content_allow WHERE sender = ?').get(sender)
  let r = await renderMessage(raw, null)
  let remoteShown = false
  if ((opts.showRemote || senderAllowed) && r.remoteUrls.length) {
    // Pomalé obrázky nezdržia zobrazenie – keď dobehnú, rozhranie si správu načíta znova.
    const onLate = (): void => ctx.emit?.('messages.remoteReady', { id: base.id })
    const map = await (ctx.fetchRemote ?? fetchRemoteImages)(r.remoteUrls, { onLate })
    r = await renderMessage(raw, map)
    remoteShown = true
  }
  return {
    id: base.id,
    accountId: base.accountId,
    subject: r.subject || base.subject,
    from: r.from,
    to: r.to,
    cc: r.cc,
    replyTo: r.replyTo,
    date: r.date ?? base.date,
    html: r.html,
    text: r.text,
    attachments: r.attachments,
    remoteBlocked: r.remoteBlocked,
    remoteShown,
    senderAllowed,
    unsubscribe: r.unsubscribe ? (r.unsubscribe.oneClick ? 'oneClick' : r.unsubscribe.mailto ? 'mailto' : 'url') : null
  }
}
