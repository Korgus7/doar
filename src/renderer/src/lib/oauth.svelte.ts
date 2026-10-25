import type { OAuthProvider } from '../../../shared/ipc'
import { t, i18n } from '../i18n/index.svelte'

/**
 * Prihlásenie cez Microsoft/Google: jadro pripraví adresu, rozhranie ju otvorí v prehliadači
 * používateľa a počká na dokončenie. Vráti ID prihlásenia (na overenie a uloženie konta).
 */
export async function oauthSignIn(provider: OAuthProvider, loginHint: string, onStarted?: (flowId: string) => void): Promise<{ flowId: string; email: string | null }> {
  const { flowId, url } = await window.doar.invoke('oauth.start', {
    provider,
    loginHint,
    lang: i18n.locale,
    text: { title: t('oauth.page.title'), done: t('oauth.page.done'), failed: t('oauth.page.failed') }
  })
  onStarted?.(flowId)
  window.doar.openExternal(url)
  const r = await window.doar.invoke('oauth.finish', { flowId })
  return { flowId, email: r.email }
}

export function oauthCancel(flowId: string | null): void {
  if (flowId) void window.doar.invoke('oauth.cancel', { flowId }).catch(() => {})
}

export function oauthProviderName(p: OAuthProvider | null | undefined): string {
  return p === 'google' ? 'Google' : p === 'microsoft' ? 'Microsoft' : ''
}
