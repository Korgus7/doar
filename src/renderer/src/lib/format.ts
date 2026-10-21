import { i18n, t } from '../i18n/index.svelte'

const intlLocale = (): string => (i18n.locale === 'sk' ? 'sk-SK' : 'en-GB')

/** Dátum v zozname: dnes → čas, včera → „Včera“, tento rok → deň a mesiac, inak celý dátum. */
export function listDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, now)) return new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(d)
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (sameDay(d, y)) return t('time.yesterday')
  if (d.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'numeric' }).format(d)
  return new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'numeric', year: 'numeric' }).format(d)
}

export function fullDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'full', timeStyle: 'short' }).format(d)
}

export function timeOnly(iso: string | null): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

export function fileSize(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: i ? 1 : 0 }).format(v)} ${units[i]}`
}

export function addressLine(list: { name: string; address: string }[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')
}
