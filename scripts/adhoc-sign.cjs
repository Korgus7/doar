/**
 * Mac bez certifikátu Apple: po zabalení sa program podpíše „ad-hoc“ (bez identity). Mac s čipom Apple
 * (M1 a novšie) nepodpísaný program vôbec nespustí; ad-hoc podpis stačí, aby ho používateľ mohol povoliť
 * v Nastaveniach → Súkromie a bezpečnosť. Na Windowse nerobí nič.
 */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  // Podpisovať vie len Mac (codesign); skúšobné zabalenie na inom systéme podpis vynechá.
  if (process.platform !== 'darwin') {
    console.warn('adhoc-sign: nie je Mac – podpis sa vynecháva')
    return
  }
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
