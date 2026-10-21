/**
 * Stiahnutie vzdialených obrázkov – len na výslovný pokyn používateľa.
 * Sťahuje jadro (nie rozhranie), obrázky sa vložia ako data: URI, takže CSP rozhrania ostáva prísny.
 */
const MAX_IMAGES = 60
const MAX_BYTES = 5 * 1024 * 1024
const TIMEOUT = 10_000

export async function fetchRemoteImages(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const list = urls.filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_IMAGES)
  await Promise.all(
    list.map(async (url) => {
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
        if (!res.ok || !type.startsWith('image/') || type.includes('svg')) return
        const len = Number(res.headers.get('content-length') ?? 0)
        if (len > MAX_BYTES) return
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > MAX_BYTES) return
        out.set(url, `data:${type};base64,${buf.toString('base64')}`)
      } catch {
        // obrázok sa nezobrazí
      }
    })
  )
  return out
}
