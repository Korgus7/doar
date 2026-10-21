import { mount } from 'svelte'
import App from './App.svelte'
import ComposeApp from './ComposeApp.svelte'
import './styles/base.css'

const target = document.getElementById('app')
if (!target) throw new Error('#app chýba')

// To isté rozhranie slúži hlavnému oknu aj oknu na písanie správy (?compose=new|reply|replyAll&id=…).
const params = new URLSearchParams(location.search)
const compose = params.get('compose')

export default compose
  ? mount(ComposeApp, { target, props: { mode: compose === 'reply' || compose === 'replyAll' ? compose : 'new', messageId: Number(params.get('id')) || undefined } })
  : mount(App, { target })
