import { mount } from 'svelte'
import App from './App.svelte'
import ComposeApp from './ComposeApp.svelte'
import './styles/base.css'
import { isComposeMode } from '../../shared/ipc'
import { initTheme } from './lib/theme'

// Vzhľad ešte pred vykreslením (bez preblesknutia svetlej/tmavej).
initTheme()

const target = document.getElementById('app')
if (!target) throw new Error('#app chýba')

// To isté rozhranie slúži hlavnému oknu aj oknu na písanie správy (?compose=new|reply|replyAll|forward&id=…&to=…).
const params = new URLSearchParams(location.search)
const compose = params.get('compose')

export default compose
  ? mount(ComposeApp, { target, props: { mode: isComposeMode(compose) ? compose : 'new', messageId: Number(params.get('id')) || undefined, to: params.get('to') ?? undefined } })
  : mount(App, { target })
