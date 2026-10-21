import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Spustí zostavenú aplikáciu (out/) s prázdnym dátovým priečinkom. */
export async function launchApp(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; dataDir: string }> {
  const dataDir = env['DOAR_DATA_DIR'] ?? mkdtempSync(join(tmpdir(), 'doar-e2e-'))
  const args = ['.']
  // Chromium pod rootom (CI kontajner) vyžaduje vypnutý OS sandbox; v bežnom behu sa nepoužije.
  if (process.getuid?.() === 0) args.push('--no-sandbox')
  // Dôvera k certifikátu testovacieho servera – ako keby ho pridal správca systému.
  const ca = process.env['DOAR_TEST_CA'] ? { NODE_EXTRA_CA_CERTS: process.env['DOAR_TEST_CA'] } : {}
  const app = await electron.launch({ args, env: { ...process.env, ...ca, ...env, DOAR_DATA_DIR: dataDir } as Record<string, string> })
  return { app, dataDir }
}

export interface E2eServer {
  host: string
  ports: { imap: number; imaps: number; smtp: number; smtps: number }
  password: string
}

export function testServer(): E2eServer | null {
  const raw = process.env['DOAR_TEST_SERVER']
  return raw ? (JSON.parse(raw) as E2eServer) : null
}

/**
 * Pridá konto cez sprievodcu (slovenské rozhranie). Na Linuxe bez kľúčenky zvolí „bez uloženia hesla“.
 */
export async function addAccountViaWizard(win: Page, srv: E2eServer, user: string, opts: { openWizard?: boolean } = {}): Promise<void> {
  if (opts.openWizard !== false) await win.getByRole('button', { name: 'Pridať konto' }).click()
  await win.getByLabel('Vaše meno').fill('Test')
  await win.getByLabel('E‑mailová adresa').fill(`${user}@doar.test`)
  await win.getByLabel('Heslo').fill(srv.password)
  await win.getByRole('button', { name: 'Pokračovať' }).click()
  await expect(win.getByText('Nastavenia sa nepodarilo zistiť automaticky', { exact: false })).toBeVisible({ timeout: 40_000 })
  await win.getByLabel('Server').nth(0).fill('127.0.0.1')
  await win.getByLabel('Port').nth(0).fill(String(srv.ports.imaps))
  await win.getByLabel('Server').nth(1).fill('127.0.0.1')
  await win.getByLabel('Port').nth(1).fill(String(srv.ports.smtps))
  await win.getByRole('button', { name: 'Overiť a uložiť' }).click()
  const sessionOnly = win.getByRole('button', { name: 'Pokračovať bez uloženia hesla' })
  const shell = win.getByRole('navigation', { name: 'Priečinky' })
  await expect(sessionOnly.or(shell)).toBeVisible({ timeout: 30_000 })
  if (await sessionOnly.isVisible()) await sessionOnly.click()
  await expect(shell).toBeVisible()
}
