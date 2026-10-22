import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileGrants, safeFilename, uniqueName } from '../../src/core/files'
import { isDangerousFile } from '../../src/shared/ipc'

describe('názvy súborov príloh', () => {
  it('odstráni cesty, zakázané znaky a rezervované mená Windows', () => {
    expect(safeFilename('../../Windows/system32/x.dll')).toBe('_.._Windows_system32_x.dll')
    expect(safeFilename('faktúra: jún?.pdf')).toBe('faktúra_ jún_.pdf')
    expect(safeFilename('CON.txt')).toBe('_CON.txt')
    expect(safeFilename('  .skryty.  ')).toBe('skryty')
    expect(safeFilename('')).toBe('priloha')
    // Znaky na obrátenie smeru textu (faktura‮fdp.exe) sa nesmú dostať do názvu.
    expect(safeFilename('faktura‮fdp.exe')).toBe('faktura_fdp.exe')
    expect(Buffer.byteLength(safeFilename('ž'.repeat(300) + '.pdf'))).toBeLessThanOrEqual(200)
    expect(safeFilename('ž'.repeat(300) + '.pdf').endsWith('.pdf')).toBe(true)
  })

  it('jedinečný názov v priečinku', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doar-names-'))
    writeFileSync(join(dir, 'a.pdf'), '')
    const used = new Set<string>()
    expect(uniqueName(dir, 'a.pdf', used)).toBe('a (2).pdf')
    expect(uniqueName(dir, 'a.pdf', used)).toBe('a (3).pdf')
    expect(uniqueName(dir, 'b.pdf', used)).toBe('b.pdf')
    expect(uniqueName(dir, 'B.PDF', used)).toBe('B (2).PDF')
  })

  it('spustiteľné súbory', () => {
    for (const n of ['setup.exe', 'Faktura.pdf.EXE', 'skript.ps1', 'x.js', 'odkaz.lnk', 'a.bat', 'b.vbs', 'c.msi', 'makro.docm', 'obraz.iso', 'bez-pripony', 'zle.exe. . ']) {
      expect(isDangerousFile(n), n).toBe(true)
    }
    for (const n of ['faktura.pdf', 'foto.JPG', 'tabulka.xlsx', 'text.txt', 'archiv.zip', 'dokument.docx']) expect(isDangerousFile(n), n).toBe(false)
  })

  it('povolenia ciest', async () => {
    const g = new FileGrants()
    g.allow('/tmp/a/../b.txt', 'read')
    expect(g.has('/tmp/b.txt', 'read')).toBe(true)
    expect(g.has('/tmp/b.txt', 'write')).toBe(false)
    await expect(g.require('/tmp/c.txt', 'read')).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
  })
})
