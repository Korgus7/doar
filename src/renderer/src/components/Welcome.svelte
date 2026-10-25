<script lang="ts">
  import { t, i18n, setLocale, AVAILABLE_LOCALES, type Locale } from '../i18n/index.svelte'
  import { LOCALE_NAMES } from '../../../shared/ipc'

  let { onAddAccount }: { onAddAccount: () => void } = $props()


  function onLocaleChange(e: Event): void {
    setLocale((e.currentTarget as HTMLSelectElement).value as Locale)
  }
</script>

<section class="welcome" aria-labelledby="welcome-title">
  <div class="card">
    <div class="logo" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="56" height="56">
        <rect x="4" y="10" width="40" height="28" rx="6" fill="var(--accent)" />
        <path d="M8 15 L24 27 L40 15" fill="none" stroke="var(--accent-text)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>
    <h1 id="welcome-title">{t('welcome.title')}</h1>
    <p class="lead">{t('welcome.lead')}</p>
    <button class="btn btn-primary big" type="button" onclick={onAddAccount}>{t('welcome.addAccount')}</button>
    <p class="privacy">{t('welcome.privacy')}</p>

    <label class="lang">
      <span>{t('settings.language')}</span>
      <select value={i18n.locale} onchange={onLocaleChange}>
        {#each AVAILABLE_LOCALES as l (l)}
          <option value={l}>{LOCALE_NAMES[l]}</option>
        {/each}
      </select>
    </label>
  </div>
</section>

<style>
  .welcome {
    display: grid;
    place-items: center;
    min-height: 100%;
    padding: 2rem;
  }
  .card {
    width: min(460px, 100%);
    text-align: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 2.5rem 2rem 1.5rem;
    box-shadow: var(--shadow);
  }
  h1 {
    margin: 0.75rem 0 0.25rem;
    font-size: 1.6rem;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .lead {
    margin: 0 0 1.5rem;
    color: var(--text-muted);
  }
  .big {
    padding: 0.7em 1.6em;
    font-size: 1.05rem;
  }
  .big:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .privacy {
    margin: 1.5rem 0 1rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .lang {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    color: var(--text-muted);
  }
  select {
    padding: 0.3em 0.5em;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
  }
</style>
