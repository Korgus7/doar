import type { MessageView } from '../../../shared/ipc'
import { t } from '../i18n/index.svelte'
import { addressLine, fileSize, fullDate } from './format'
import { escapeHtml } from './compose-html'

/**
 * Dokument na tlač správy: hlavička (od, komu, dátum, predmet) a telo. Telo je HTML prečistené jadrom
 * (rovnaké ako v čítaní); dokument nemá skripty a nesmie nič načítať z internetu (CSP).
 */
export function printDocument(view: MessageView): string {
  const row = (label: string, value: string): string => (value ? `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>` : '')
  const atts = view.attachments.map((a) => `${a.filename} (${fileSize(a.size)})`).join(', ')
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
<title>${escapeHtml(view.subject)}</title>
<style>
body{font:11pt/1.45 'Segoe UI',Arial,sans-serif;color:#000;margin:0}
h1{font-size:15pt;margin:0 0 8pt}
table.head{border-collapse:collapse;margin-bottom:10pt;font-size:10pt}
table.head th{text-align:left;font-weight:600;padding:1pt 10pt 1pt 0;vertical-align:top;color:#333;white-space:nowrap}
table.head td{padding:1pt 0}
hr{border:0;border-top:1px solid #999;margin:0 0 12pt}
img{max-width:100%;height:auto}
blockquote{margin:0 0 0 .4em;padding-left:.8em;border-left:2px solid #999}
.doar-plain{white-space:pre-wrap}
</style></head><body>
<h1>${escapeHtml(view.subject || t('list.noSubject'))}</h1>
<table class="head">
${row(t('print.from'), addressLine(view.from))}
${row(t('print.to'), addressLine(view.to))}
${row(t('print.cc'), addressLine(view.cc))}
${row(t('print.date'), fullDate(view.date))}
${row(t('print.attachments'), atts)}
</table><hr>
${view.html ?? ''}
</body></html>`
}
