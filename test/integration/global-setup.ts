import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { startTestServer, type TestServer } from '../../scripts/testserver.mjs'

export interface ProvidedServer {
  dir: string
  caPath: string
  host: string
  ports: TestServer['ports']
  password: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    testserver: ProvidedServer
  }
}

/**
 * Jeden testovací server pre všetky integračné testy.
 * Jeho certifikát pridáme medzi dôveryhodné cez NODE_EXTRA_CA_CERTS – rovnako ako by ho
 * pridal správca systému. Kód aplikácie tak overuje certifikát úplne bežne, bez výnimiek pre testy.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const srv = await startTestServer({ dir: '.testserver/integration' })
  const caPath = join(srv.dir, 'cert.pem')
  process.env['NODE_EXTRA_CA_CERTS'] = caPath
  project.provide('testserver', { dir: srv.dir, caPath, host: srv.host, ports: srv.ports, password: srv.password })
  return () => srv.stop()
}
