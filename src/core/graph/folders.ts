import type { SpecialUse } from '../../shared/ipc'
import type { GraphClient, GraphError } from './client'

export const WELL_KNOWN: [SpecialUse, string][] = [
  ['inbox', 'inbox'],
  ['sent', 'sentitems'],
  ['drafts', 'drafts'],
  ['trash', 'deleteditems'],
  ['junk', 'junkemail'],
  ['archive', 'archive']
]
/** Priečinky, ktoré sa nezobrazujú ani nezálohujú (Pošta na odoslanie Outlooku – Doar má vlastnú frontu). */
const HIDDEN_WELL_KNOWN = ['outbox']

export interface GraphFolderNode {
  id: string
  name: string
  /** ID nadradeného priečinka; null = najvyššia úroveň. */
  parent: string | null
  specialUse: SpecialUse | null
}

/** ID špeciálnych priečinkov (nemenia sa – dajú sa držať v pamäti). */
export interface WellKnownIds {
  special: Map<string, SpecialUse>
  hidden: Set<string>
}

export async function wellKnownIds(graph: GraphClient): Promise<WellKnownIds> {
  const special = new Map<string, SpecialUse>()
  const hidden = new Set<string>()
  const id = async (name: string): Promise<string | null> => {
    try {
      return (await graph.get<{ id: string }>(`/me/mailFolders/${name}?$select=id`)).id
    } catch (e) {
      if ((e as GraphError).code === 'NOT_FOUND') return null
      throw e
    }
  }
  for (const [use, name] of WELL_KNOWN) {
    const x = await id(name)
    if (x) special.set(x, use)
  }
  for (const name of HIDDEN_WELL_KNOWN) {
    const x = await id(name)
    if (x) hidden.add(x)
  }
  return { special, hidden }
}

/** Celý strom priečinkov pošty (bez skrytých), rodičia pred deťmi. */
export async function graphFolderTree(graph: GraphClient, known: WellKnownIds): Promise<GraphFolderNode[]> {
  const fields = '$select=id,displayName,parentFolderId,childFolderCount&$top=250'
  type F = { id: string; displayName: string; childFolderCount?: number }
  const all: { f: F; parent: string | null }[] = (await graph.getAll<F>(`/me/mailFolders?${fields}`)).map((f) => ({ f, parent: null }))
  for (let i = 0; i < all.length && i < 5000; i++) {
    const { f } = all[i]!
    if ((f.childFolderCount ?? 0) > 0) {
      for (const c of await graph.getAll<F>(`/me/mailFolders/${encodeURIComponent(f.id)}/childFolders?${fields}`)) all.push({ f: c, parent: f.id })
    }
  }
  return all.filter(({ f }) => !known.hidden.has(f.id)).map(({ f, parent }) => ({ id: f.id, name: f.displayName, parent, specialUse: known.special.get(f.id) ?? null }))
}
