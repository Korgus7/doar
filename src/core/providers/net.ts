import { promises as dns } from 'node:dns'
import net from 'node:net'
import tls from 'node:tls'
import type { Security } from '../../shared/ipc'

/** Sieťové operácie pre zisťovanie nastavení – oddelené, aby sa dali v testoch nahradiť. */
export interface DiscoveryNet {
  fetchText(url: string, timeoutMs: number): Promise<string | null>
  resolveSrv(name: string): Promise<{ name: string; port: number; priority: number; weight: number }[]>
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>
  probe(host: string, port: number, security: Security, timeoutMs: number): Promise<ProbeResult>
}

export interface ProbeResult {
  ok: boolean
  /** Certifikát nesedí s menom servera – pre aké mená platí. */
  certHosts?: string[]
}

const MAX_BYTES = 256 * 1024

export const realNet: DiscoveryNet = {
  async fetchText(url, timeoutMs) {
    // Len HTTPS – odpoveď cez nešifrované HTTP by mohol niekto podvrhnúť.
    if (!url.startsWith('https://')) return null
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { accept: 'text/xml, application/xml' } })
      if (!res.ok || !res.url.startsWith('https://')) return null
      const text = await res.text()
      return text.length > MAX_BYTES ? null : text
    } catch {
      return null
    }
  },

  async resolveSrv(name) {
    try {
      return await dns.resolveSrv(name)
    } catch {
      return []
    }
  },

  async resolveMx(domain) {
    try {
      return await dns.resolveMx(domain)
    } catch {
      return []
    }
  },

  probe(host, port, security, timeoutMs) {
    return new Promise<ProbeResult>((resolve) => {
      let done = false
      const finish = (r: ProbeResult, s?: net.Socket): void => {
        if (done) return
        done = true
        s?.destroy()
        resolve(r)
      }
      const timer = setTimeout(() => finish({ ok: false }), timeoutMs)
      const end = (r: ProbeResult, s?: net.Socket): void => {
        clearTimeout(timer)
        finish(r, s)
      }

      if (security === 'tls') {
        const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true })
        s.once('secureConnect', () => end({ ok: true }, s))
        s.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
            // Spojenie bez overenia len kvôli prečítaniu mien v certifikáte (nič sa neposiela).
            const peek = tls.connect({ host, port, servername: host, rejectUnauthorized: false })
            peek.once('secureConnect', () => end({ ok: false, certHosts: certNames(peek.getPeerCertificate()) }, peek))
            peek.once('error', () => end({ ok: false }))
          } else end({ ok: false }, s)
        })
      } else {
        // STARTTLS porty: stačí, že server odpovie úvodnou správou protokolu (úplné overenie robí test spojenia).
        const s = net.connect({ host, port })
        s.setEncoding('latin1')
        s.once('data', (d: string) => end({ ok: /^(\* OK|220[ -])/.test(d) }, s))
        s.once('error', () => end({ ok: false }, s))
      }
    })
  }
}

/**
 * Prečíta mená, pre ktoré platí certifikát servera – aj cez STARTTLS.
 * Spojenie sa nadviaže bez overenia certifikátu výlučne na prečítanie mien:
 * neposiela sa nič okrem príkazu STARTTLS (žiadne meno ani heslo) a spojenie sa hneď zavrie.
 */
export function peekCertHosts(host: string, port: number, security: Security, protocol: 'imap' | 'smtp', timeoutMs = 8000): Promise<string[]> {
  return new Promise((resolve) => {
    let done = false
    let sock: net.Socket | null = null
    const finish = (names: string[]): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock?.destroy()
      resolve(names)
    }
    const timer = setTimeout(() => finish([]), timeoutMs)
    const upgrade = (base?: net.Socket): void => {
      const t = tls.connect({ host, port, socket: base, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false })
      sock = t
      t.once('secureConnect', () => finish(certNames(t.getPeerCertificate())))
      t.once('error', () => finish([]))
    }
    if (security === 'tls') return upgrade()

    const s = net.connect({ host, port })
    sock = s
    let buf = ''
    let stage = 0
    // Bez setEncoding – socket sa neskôr odovzdá TLS vrstve.
    s.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1')
      if (protocol === 'imap') {
        if (stage === 0 && /^\* OK/m.test(buf)) {
          stage = 1
          buf = ''
          s.write('a1 STARTTLS\r\n')
        } else if (stage === 1 && /^a1 /m.test(buf)) {
          if (!/^a1 OK/m.test(buf)) return finish([])
          s.removeAllListeners('data')
          upgrade(s)
        }
      } else {
        if (stage === 0 && /^220 /m.test(buf)) {
          stage = 1
          buf = ''
          s.write('EHLO doar.local\r\n')
        } else if (stage === 1 && /^250 /m.test(buf)) {
          stage = 2
          buf = ''
          s.write('STARTTLS\r\n')
        } else if (stage === 2 && /^\d{3} /m.test(buf)) {
          if (!/^220 /m.test(buf)) return finish([])
          s.removeAllListeners('data')
          upgrade(s)
        }
      }
    })
    s.once('error', () => finish([]))
  })
}

export function certNames(cert: tls.PeerCertificate | undefined): string[] {
  if (!cert) return []
  const names = new Set<string>()
  for (const part of (cert.subjectaltname ?? '').split(',')) {
    const m = part.trim().match(/^DNS:(.+)$/)
    if (m?.[1]) names.add(m[1].toLowerCase())
  }
  const cn = cert.subject?.CN
  if (typeof cn === 'string') names.add(cn.toLowerCase())
  return [...names]
}
