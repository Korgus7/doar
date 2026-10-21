import type { CoreToMain, MainToCore } from '../shared/ipc'

/** Prístup k tajomstvám (heslá). V aplikácii ich drží main proces cez safeStorage. */
export interface Secrets {
  /** Je k dispozícii šifrované úložisko operačného systému? */
  available(): Promise<boolean>
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

type Post = (msg: CoreToMain) => void
type Result = Extract<MainToCore, { kind: 'secret.result' }>

/** Klient, ktorý sa pýta main procesu. */
export class MainSecrets implements Secrets {
  private seq = 1
  private waiters = new Map<number, (r: Result) => void>()

  constructor(private readonly post: Post) {}

  /** Volá core/index.ts pri prijatí odpovede od main. */
  resolve(r: Result): void {
    const w = this.waiters.get(r.id)
    this.waiters.delete(r.id)
    w?.(r)
  }

  private ask(msg: DistributiveOmit<Exclude<CoreToMain, { kind: 'ready' }>, 'id'>): Promise<Result> {
    const id = this.seq++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error('SECRET_TIMEOUT'))
      }, 10_000)
      this.waiters.set(id, (r) => {
        clearTimeout(timer)
        if (r.ok) resolve(r)
        else reject(new Error(r.error ?? 'SECRET_ERROR'))
      })
      this.post({ ...msg, id } as CoreToMain)
    })
  }

  async available(): Promise<boolean> {
    return (await this.ask({ kind: 'secret.status' })).value === 'secure'
  }
  async get(key: string): Promise<string | null> {
    return (await this.ask({ kind: 'secret.get', key })).value ?? null
  }
  async set(key: string, value: string): Promise<void> {
    await this.ask({ kind: 'secret.set', key, value })
  }
  async delete(key: string): Promise<void> {
    await this.ask({ kind: 'secret.delete', key })
  }
}

/** Tajomstvá len v pamäti – pre testy a pre heslá „do zatvorenia aplikácie“. */
export class MemorySecrets implements Secrets {
  private map = new Map<string, string>()
  constructor(private readonly secure = true) {}
  async available(): Promise<boolean> {
    return this.secure
  }
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
}

export const passwordKey = (accountId: number): string => `account:${accountId}:password`

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
