import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startTestServer } from '../../scripts/testserver.mjs'

/**
 * Testovací poštový server pre e2e testy – len tam, kde je Dovecot (Linux/WSL/CI).
 * Inde sa testy, ktoré ho potrebujú, preskočia.
 */
export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  if (!['/usr/sbin/dovecot', '/usr/local/sbin/dovecot'].some((p) => existsSync(p))) return
  const srv = await startTestServer({ dir: '.testserver/e2e' })
  process.env['DOAR_TEST_CA'] = join(srv.dir, 'cert.pem')
  process.env['DOAR_TEST_SERVER'] = JSON.stringify({ host: srv.host, ports: srv.ports, password: srv.password })
  return () => srv.stop()
}
