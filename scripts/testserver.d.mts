export interface TestServer {
  dir: string
  ca: Buffer
  host: string
  ports: { imap: number; imaps: number; smtp: number; smtps: number; lmtp: number }
  password: string
  user(name: string): string
  stop(): Promise<void>
}
export const TEST_PASSWORD: string
export const TEST_DOMAIN: string
export const PORTS: TestServer['ports']
export function startTestServer(opts?: { dir?: string; fresh?: boolean }): Promise<TestServer>
