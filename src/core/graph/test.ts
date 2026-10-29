import type { ConnectionErrorCode, ConnectionTestResult, ProtocolTestResult } from '../../shared/ipc'
import { GraphClient, type GraphError, type GraphFetch } from './client'

const KNOWN: ConnectionErrorCode[] = ['NO_NETWORK', 'AUTH_FAILED', 'TIMEOUT', 'PROTOCOL', 'GRAPH_MAILBOX', 'GRAPH_FORBIDDEN']

/** Overenie konta cez Microsoft Graph: prístup k doručenej pošte (čítanie aj odosielanie ide cez ten istý token). */
export async function testGraph(accessToken: string, opts: { base?: string; fetch?: GraphFetch } = {}): Promise<ConnectionTestResult> {
  let r: ProtocolTestResult
  try {
    await new GraphClient(async () => accessToken, { ...opts, timeoutMs: 30_000 }).get('/me/mailFolders/inbox?$select=id')
    r = { ok: true }
  } catch (e) {
    const g = e as GraphError
    r = { ok: false, code: KNOWN.includes(g.code as ConnectionErrorCode) ? (g.code as ConnectionErrorCode) : 'UNKNOWN', detail: g.message.slice(0, 300) }
  }
  return { imap: r, smtp: r, graph: true }
}
