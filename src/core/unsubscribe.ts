import { originalRaw, sendCompose, type Ctx } from './compose-service'
import { unsubscribeOf } from './mail/parse'
import { logger } from './log'

const log = logger('unsubscribe')

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export type UnsubscribeFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>

/**
 * Odhlásenie z odberu (na výslovnú žiadosť používateľa – kliknutie s potvrdením):
 * 1. jedným klikom (RFC 8058): POST na https adresu odosielateľa, bez otvárania stránky,
 * 2. e-mailom: správa na adresu z mailto: (z konta, na ktoré správa prišla; adresa sa nepamätá),
 * 3. inak stránku otvorí rozhranie v prehliadači.
 */
export async function unsubscribe(ctx: Ctx, messageId: number, fetchFn: UnsubscribeFetch = (u, i) => fetch(u, i)): Promise<{ done: 'oneClick' | 'mailto' } | { open: string }> {
  const { raw, accountId } = await originalRaw(ctx, messageId)
  const u = await unsubscribeOf(raw)
  if (!u) throw err('NO_UNSUBSCRIBE', 'Správa neponúka odhlásenie z odberu')
  if (u.oneClick) {
    try {
      const res = await fetchFn(u.oneClick, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        signal: AbortSignal.timeout(20_000)
      })
      if (res.ok) return { done: 'oneClick' }
      log.warn('odhlásenie jedným klikom odmietnuté', { status: res.status })
    } catch {
      log.warn('odhlásenie jedným klikom zlyhalo')
    }
  }
  if (u.mailto) {
    const m = /^mailto:([^?]+)(?:\?(.*))?$/i.exec(u.mailto)
    if (m) {
      const q = new URLSearchParams(m[2] ?? '')
      const to = decodeURIComponent(m[1]!)
      await sendCompose(
        ctx,
        { accountId, to, cc: '', bcc: '', subject: (q.get('subject') ?? '').slice(0, 300) || 'unsubscribe', text: (q.get('body') ?? '').slice(0, 2000) || 'unsubscribe', replyToMessage: null },
        { remember: false }
      )
      return { done: 'mailto' }
    }
  }
  if (u.url) return { open: u.url }
  throw err('UNSUBSCRIBE_FAILED', 'Odhlásenie sa nepodarilo')
}
