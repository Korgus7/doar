/**
 * Stiahnutie vzdialených obrázkov – len na výslovný pokyn používateľa (alebo pre povoleného odosielateľa).
 * Sťahuje jadro (nie rozhranie), obrázky sa vložia ako data: URI, takže CSP rozhrania ostáva prísny.
 *
 * Rýchlosť: obrázky sa sťahujú naraz a správa sa zobrazí najneskôr po WAIT_MS s tým, čo už prišlo –
 * pomalé servery (napr. sledovacie pixely) ju nezdržia. Zvyšok sa dotiahne na pozadí a cez `onLate`
 * sa správa zobrazí znova. Stiahnuté obrázky si jadro pamätá (do zatvorenia aplikácie), takže ďalšie
 * otvorenie tej istej správy alebo správy s rovnakými obrázkami (logá, newslettre) je hneď.
 */
const MAX_IMAGES = 120
const MAX_BYTES = 5 * 1024 * 1024
const TIMEOUT = 15_000
/** Najdlhšie čakanie pred prvým zobrazením správy s obrázkami. */
export const WAIT_MS = 2500
/** Pamäť stiahnutých obrázkov (súčet veľkostí data: URI). */
const CACHE_MAX = 64 * 1024 * 1024
/** Obrázok, ktorý sa nepodarilo stiahnuť, sa znova skúsi až po tomto čase. */
const RETRY_FAILED_MS = 10 * 60_000

const cache = new Map<string, string>()
let cacheBytes = 0
const failed = new Map<string, number>()
const inflight = new Map<string, Promise<string | null>>()

function remember(url: string, data: string): void {
  if (data.length > CACHE_MAX / 4) return
  cache.delete(url)
  cache.set(url, data)
  cacheBytes += data.length
  // Najstaršie preč (Map drží poradie vloženia).
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_MAX) break
    cache.delete(k)
    cacheBytes -= v.length
  }
}

async function download(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: 'follow',
      // Žiadne cookies ani referer – nič neprezradíme navyše.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'image/*' }
    })
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!res.ok || !type.startsWith('image/') || type.includes('svg')) return null
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_BYTES) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_BYTES) return null
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function fetchOne(url: string): Promise<string | null> {
  const hit = cache.get(url)
  if (hit) return Promise.resolve(hit)
  const f = failed.get(url)
  if (f && Date.now() - f < RETRY_FAILED_MS) return Promise.resolve(null)
  const running = inflight.get(url)
  if (running) return running
  const p = download(url).then((data) => {
    inflight.delete(url)
    if (data) {
      failed.delete(url)
      remember(url, data)
    } else failed.set(url, Date.now())
    return data
  })
  inflight.set(url, p)
  return p
}

/**
 * Vráti obrázky, ktoré prišli do `waitMs`. Ak niektoré ešte chýbajú, sťahujú sa ďalej a po dokončení
 * sa zavolá `onLate` (len ak pribudol aspoň jeden obrázok).
 */
export async function fetchRemoteImages(urls: string[], opts: { waitMs?: number; onLate?: () => void } = {}): Promise<Map<string, string>> {
  const list = [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))].slice(0, MAX_IMAGES)
  const out = new Map<string, string>()
  const all = Promise.all(list.map((u) => fetchOne(u).then((d) => (d ? out.set(u, d) : null))))
  let timer: ReturnType<typeof setTimeout> | undefined
  const done = await Promise.race([all.then(() => true), new Promise<false>((r) => (timer = setTimeout(() => r(false), opts.waitMs ?? WAIT_MS)))])
  clearTimeout(timer)
  const now = new Map(out)
  if (!done && opts.onLate) {
    const onLate = opts.onLate
    void all.then(() => {
      if (out.size > now.size) onLate()
    })
  }
  return now
}

/** Pre testy: vyprázdniť pamäť obrázkov. */
export function clearRemoteCache(): void {
  cache.clear()
  failed.clear()
  inflight.clear()
  cacheBytes = 0
}
