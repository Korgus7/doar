export interface TestServer {
  dir: string
  ca: Buffer
  host: string
  ports: { imap: number; imaps: number; smtp: number; smtps: number; lmtp: number; oauth: number }
  password: string
  user(name: string): string
  stop(): Promise<void>
}
export const TEST_PASSWORD: string
export const TEST_DOMAIN: string
export const PORTS: TestServer['ports']
/** Prístupový token pre XOAUTH2 na testovací server (platí ttlMs). */
export function testAccessToken(email: string, ttlMs?: number): string
export function startTestServer(opts?: { dir?: string; fresh?: boolean }): Promise<TestServer>
