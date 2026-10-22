import { safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Úložisko tajomstiev (heslá, tokeny, AI kľúče).
 * Šifruje cez safeStorage (Windows DPAPI, macOS Keychain, Linux libsecret).
 * Do súboru ide len šifrovaný text v base64, nikdy otvorený text.
 */
export class SecretStore {
  private cache: Record<string, string> | null = null

  constructor(private readonly file: string) {}

  /** Je k dispozícii skutočné šifrovanie operačného systému? */
  async status(): Promise<{ available: boolean; backend: string }> {
    const available = await safeStorage.isAsyncEncryptionAvailable()
    let backend = process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'unknown'
    if (process.platform === 'linux') {
      try {
        backend = safeStorage.getSelectedStorageBackend()
      } catch {
        backend = 'unknown'
      }
    }
    // Na Linuxe "basic_text" znamená len pevný kľúč v kóde – nepovažujeme za bezpečné.
    const secure = available && backend !== 'basic_text' && backend !== 'unknown'
    return { available: secure, backend }
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache
    this.cache = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>) : {}
    return this.cache
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.cache ?? {}), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  async get(key: string): Promise<string | null> {
    const enc = this.load()[key]
    if (!enc) return null
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))
    // Systém zmenil kľúč (napr. po aktualizácii) – uložiť znova novým kľúčom.
    if (shouldReEncrypt) await this.set(key, result)
    return result
  }

  async set(key: string, value: string): Promise<void> {
    if (!(await this.status()).available) {
      throw new Error('SECURE_STORAGE_UNAVAILABLE')
    }
    this.load()[key] = (await safeStorage.encryptStringAsync(value)).toString('base64')
    this.save()
  }

  delete(key: string): void {
    delete this.load()[key]
    this.save()
  }
}
