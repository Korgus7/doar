import { mount } from 'svelte'
import App from './App.svelte'
import ComposeApp from './ComposeApp.svelte'
import MessageApp from './MessageApp.svelte'
import './styles/base.css'
import { isComposeMode } from '../../shared/ipc'
import { initTheme } from './lib/theme'

// Vzhľad ešte pred vykreslením (bez preblesknutia svetlej/tmavej).
initTheme()

const target = document.getElementById('app')
if (!target) throw new Error('#app chýba')

// To isté rozhranie slúži hlavnému oknu, oknu na písanie správy (?compose=new|reply|replyAll|forward&id=…&to=…)
// aj oknu jednej správy (?view=message&id=…).
const params = new URLSearchParams(location.search)
const compose = params.get('compose')
const messageId = Number(params.get('id'))

export default compose
  ? mount(ComposeApp, { target, props: { mode: isComposeMode(compose) ? compose : 'new', messageId: messageId || undefined, to: params.get('to') ?? undefined } })
  : params.get('view') === 'message' && Number.isInteger(messageId) && messageId !== 0
    ? mount(MessageApp, { target, props: { messageId } })
    : mount(App, { target })
