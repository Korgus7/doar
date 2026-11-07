import { describe, it, expect } from 'vitest'
import { needsRescue, RESCUE_MIN } from '../../src/core/sync/account-sync'
import { rescueFileName } from '../../src/core/export/rescue'

describe('záchrana lokálnych kópií pred hromadným zmazaním', () => {
  it('bežné mazanie inde (po jednej, pár správ) nič neukladá', () => {
    expect(needsRescue('inbox', 0, 500)).toBe(false)
    expect(needsRescue('inbox', 1, 3)).toBe(false)
    expect(needsRescue(null, 4, 4)).toBe(false) // malý priečinok vyprázdnený – priveľa drobných súborov by len zavadzalo
    expect(needsRescue('inbox', RESCUE_MIN - 1, RESCUE_MIN)).toBe(false)
    expect(needsRescue('inbox', 50, 1000)).toBe(false) // 5 % – upratovanie, nie strata schránky
  })

  it('naraz chýba veľa správ alebo celý priečinok → uložiť', () => {
    expect(needsRescue('inbox', 5, 5)).toBe(true)
    expect(needsRescue(null, RESCUE_MIN, RESCUE_MIN * 2)).toBe(true)
    expect(needsRescue('sent', 400, 1000)).toBe(true)
  })

  it('Kôš, Spam a Koncepty sa vyprázdňujú bežne – bez záchrany', () => {
    expect(needsRescue('trash', 1000, 1000)).toBe(false)
    expect(needsRescue('junk', 100, 100)).toBe(false)
    expect(needsRescue('drafts', 30, 30)).toBe(false)
  })

  it('názov súboru: konto, priečinok a čas, bez zakázaných znakov', () => {
    const n = rescueFileName('milan@cami.sk', 'INBOX/Faktúry', new Date(2026, 10, 5, 17, 4, 9))
    expect(n).toBe('Zachránené – milan@cami.sk – INBOX_Faktúry – 2026-11-05 17-04-09.mbox')
  })
})
