/**
 * Testovacie súbory Outlook Expressu (.dbx) podľa verejného popisu formátu – len pre testy čítačky.
 * Vytvorí Folders.dbx (hierarchia priečinkov) a priečinky so správami (strom indexu cez viac uzlov,
 * správy cez viac blokov, príznaky a dátum prijatia).
 */

const HEADER_SIZE = 0x24bc
const NODE_SIZE = 0x27c
const BLOCK = 0x200

type Prop = { idx: number; direct: number } | { idx: number; data: Buffer }

class DbxBuilder {
  private parts: Buffer[] = []
  private size = HEADER_SIZE

  private alloc(buf: Buffer): number {
    const at = this.size
    this.parts.push(buf)
    this.size += buf.length
    return at
  }

  info(props: Prop[]): number {
    const table = Buffer.alloc(props.length * 4)
    const data: Buffer[] = []
    let dataLen = 0
    props.forEach((p, i) => {
      if ('direct' in p) table.writeUInt32LE(((p.direct & 0xffffff) << 8) | 0x80 | p.idx, i * 4)
      else {
        table.writeUInt32LE((dataLen << 8) | p.idx, i * 4)
        data.push(p.data)
        dataLen += p.data.length
      }
    })
    const body = Buffer.concat([table, ...data])
    const h = Buffer.alloc(12)
    const at = this.size
    h.writeUInt32LE(at, 0)
    h.writeUInt32LE(body.length, 4)
    h.writeUInt16LE(body.length, 8)
    h[10] = props.length
    return this.alloc(Buffer.concat([h, body]))
  }

  message(raw: Buffer): number {
    const first = this.size
    for (let off = 0; off < raw.length || off === 0; off += BLOCK) {
      const chunk = raw.subarray(off, off + BLOCK)
      const at = this.size
      const last = off + BLOCK >= raw.length
      const b = Buffer.alloc(16 + BLOCK)
      b.writeUInt32LE(at, 0)
      b.writeUInt32LE(BLOCK, 4)
      b.writeUInt16LE(chunk.length, 8)
      b.writeUInt32LE(last ? 0 : at + 16 + BLOCK, 12)
      chunk.copy(b, 16)
      this.alloc(b)
      if (last) break
    }
    return first
  }

  private node(entries: { value: number; sub: number }[], child: number): number {
    const n = Buffer.alloc(NODE_SIZE)
    const at = this.size
    n.writeUInt32LE(at, 0)
    n.writeUInt32LE(child, 8)
    n[0x11] = entries.length
    entries.forEach((e, i) => {
      n.writeUInt32LE(e.value, 0x18 + i * 12)
      n.writeUInt32LE(e.sub, 0x18 + i * 12 + 4)
    })
    return this.alloc(n)
  }

  /** Strom: koreň s ľavým potomkom (prvá dávka) a položkami, z ktorých každá má vlastný podstrom (ďalšie dávky). */
  tree(values: number[]): number {
    const chunks: number[][] = []
    for (let i = 0; i < values.length; i += 10) chunks.push(values.slice(i, i + 10))
    if (chunks.length <= 1) return this.node((chunks[0] ?? []).map((v) => ({ value: v, sub: 0 })), 0)
    const left = this.node(chunks[0]!.map((v) => ({ value: v, sub: 0 })), 0)
    const rest = chunks.slice(1)
    const entries = rest.map((c) => {
      const [head, ...tail] = c
      const sub = tail.length ? this.node(tail.map((v) => ({ value: v, sub: 0 })), 0) : 0
      return { value: head!, sub }
    })
    return this.node(entries, left)
  }

  build(type: 'messages' | 'folders', count: number, root: number): Buffer {
    const h = Buffer.alloc(HEADER_SIZE)
    h.writeUInt32LE(0xfe12adcf, 0)
    h.writeUInt32LE(type === 'messages' ? 0x6f74fdc5 : 0x6f74fdc6, 4)
    h.writeUInt32LE(count, 0xc4)
    h.writeUInt32LE(root, 0xe4)
    return Buffer.concat([h, ...this.parts])
  }
}

const str = (s: string, enc: 'latin1' | 'cp1250' = 'latin1'): Buffer => {
  if (enc === 'latin1') return Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(1)])
  // windows-1250 pre slovenské znaky v testoch
  const map: Record<string, number> = { á: 0xe1, é: 0xe9, í: 0xed, ó: 0xf3, ú: 0xfa, ý: 0xfd, č: 0xe8, ď: 0xef, ľ: 0xbe, ň: 0xf2, š: 0x9a, ť: 0x9d, ž: 0x9e, ô: 0xf4, ä: 0xe4, Č: 0xc8, Š: 0x8a, Ž: 0x8e }
  return Buffer.from([...[...s].map((ch) => map[ch] ?? ch.charCodeAt(0)), 0])
}

const filetime = (d: Date): Buffer => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE((BigInt(d.getTime()) + 11644473600000n) * 10000n)
  return b
}

export interface DbxTestMessage {
  raw: Buffer
  flags?: number
  received?: Date
}

export function dbxMessages(messages: DbxTestMessage[]): Buffer {
  const b = new DbxBuilder()
  const infos = messages.map((m, i) => {
    const addr = b.message(m.raw)
    const props: Prop[] = [{ idx: 0x00, direct: i + 1 }, { idx: 0x01, data: Buffer.from(Uint32Array.of(m.flags ?? 0).buffer) }]
    if (m.received) props.push({ idx: 0x12, data: filetime(m.received) })
    props.push({ idx: 0x04, data: Buffer.from(Uint32Array.of(addr).buffer) })
    props.push({ idx: 0x08, data: str('predmet') })
    return b.info(props)
  })
  return b.build('messages', messages.length, b.tree(infos))
}

export interface DbxTestFolder {
  id: number
  parent: number
  name: string
  file?: string
}

export function dbxFolders(folders: DbxTestFolder[]): Buffer {
  const b = new DbxBuilder()
  const infos = folders.map((f) => {
    const props: Prop[] = [
      { idx: 0x00, direct: f.id },
      { idx: 0x01, direct: f.parent },
      { idx: 0x02, data: str(f.name, 'cp1250') }
    ]
    if (f.file) props.push({ idx: 0x03, data: str(f.file, 'cp1250') })
    return b.info(props)
  })
  return b.build('folders', folders.length, b.tree(infos))
}
