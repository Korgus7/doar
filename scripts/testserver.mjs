#!/usr/bin/env node
/**
 * Testovací poštový server pre Doar (len na vývoj a testy, nikdy nie produkcia).
 *
 *  IMAP  – Dovecot (skutočný server ako u bežných hostingov): 127.0.0.1:3143 (STARTTLS), :3993 (TLS)
 *  SMTP  – smtp-server (Node.js): 127.0.0.1:3587 (STARTTLS), :3465 (TLS); doručuje do Dovecotu cez LMTP
 *
 * Kontá (heslo pre všetky: doar-test-heslo):
 *  alice, bob, carol, … @doar.test; plna@doar.test (kvóta 20 kB), mala@doar.test (kvóta 12 kB)
 *
 * Simulácia porúch pri odosielaní (adresát v obálke):
 *  zlyhanie@doar.test        → server odmietne adresáta (550)
 *  prerusenie@doar.test      → server prijme DATA a spojenie zavrie bez odpovede (nejasný výsledok)
 *  prijate-prerusenie@doar.test → ako vyššie, ale správu najprv naozaj doručí ostatným adresátom
 *
 * Linux (alebo WSL): vyžaduje balík dovecot-imapd + dovecot-lmtpd a openssl.
 * Použitie: `npm run testserver` (beží do Ctrl+C), alebo import { startTestServer } v testoch.
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import net from 'node:net'
import { SMTPServer } from 'smtp-server'
import nodemailer from 'nodemailer'

export const TEST_PASSWORD = 'doar-test-heslo'
export const TEST_DOMAIN = 'doar.test'
export const PORTS = { imap: 3143, imaps: 3993, smtp: 3587, smtps: 3465, lmtp: 3024 }
const USERS = [
  { name: 'alice' },
  { name: 'bob' },
  { name: 'carol' },
  { name: 'dana' },
  { name: 'emil' },
  { name: 'filip' },
  { name: 'gita' },
  { name: 'hana' },
  { name: 'ivan' },
  { name: 'jozef' },
  { name: 'karol' },
  { name: 'lenka' },
  { name: 'marek' },
  { name: 'nina' },
  { name: 'olga' },
  { name: 'pavol' },
  { name: 'rado' },
  { name: 'sona' },
  { name: 'tomas' },
  { name: 'urban' },
  { name: 'vlado' },
  { name: 'zuzana' },
  { name: 'xaver' },
  { name: 'yvona' },
  { name: 'adam' },
  { name: 'beata' },
  { name: 'cyril' },
  { name: 'dusan' },
  { name: 'plna', quota: '20K' },
  { name: 'mala', quota: '12K' }
]

function findDovecot() {
  for (const p of ['/usr/sbin/dovecot', '/usr/local/sbin/dovecot']) if (existsSync(p)) return p
  throw new Error('Dovecot nie je nainštalovaný (sudo apt-get install dovecot-imapd dovecot-lmtpd)')
}

function makeCert(dir) {
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  if (!existsSync(cert)) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-keyout', key, '-out', cert, '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
    ], { stdio: 'ignore' })
  }
  return { key, cert }
}

function dovecotConfig(dir, { key, cert }) {
  // Dovecot neprijme poštu pod rootom; v kontajneri (root) použijeme používateľa nobody.
  const asRoot = process.getuid() === 0
  const uid = asRoot ? 65534 : process.getuid()
  const gid = asRoot ? 65534 : process.getgid()
  if (asRoot) chmodSync(join(dir, 'mail'), 0o777)
  const users = USERS.map((u) => {
    const extra = u.quota ? `userdb_quota_rule=*:storage=${u.quota}` : ''
    return `${u.name}@${TEST_DOMAIN}:{PLAIN}${TEST_PASSWORD}:${uid}:${gid}::${dir}/mail/${u.name}::${extra}`
  })
  writeFileSync(join(dir, 'users'), users.join('\n') + '\n')
  return `
base_dir = ${dir}/run
state_dir = ${dir}/state
log_path = ${dir}/dovecot.log
info_log_path = ${dir}/dovecot.log
protocols = imap lmtp
listen = 127.0.0.1
ssl = yes
ssl_cert = <${cert}
ssl_key = <${key}
ssl_min_protocol = TLSv1.2
auth_mechanisms = plain login
disable_plaintext_auth = yes
first_valid_uid = ${uid}
${asRoot ? '' : `default_internal_user = ${process.env.USER ?? 'runner'}\ndefault_login_user = ${process.env.USER ?? 'runner'}\ndefault_internal_group = ${gid}`}
passdb {
  driver = passwd-file
  args = scheme=PLAIN username_format=%u ${dir}/users
}
userdb {
  driver = passwd-file
  args = username_format=%u ${dir}/users
}
mail_location = maildir:~/Maildir:UTF-8
mail_plugins = $mail_plugins quota
namespace inbox {
  inbox = yes
  separator = /
  mailbox Drafts {
    special_use = \\Drafts
    auto = subscribe
  }
  mailbox Sent {
    special_use = \\Sent
    auto = subscribe
  }
  mailbox Trash {
    special_use = \\Trash
    auto = subscribe
  }
  mailbox Junk {
    special_use = \\Junk
    auto = subscribe
  }
  mailbox Archive {
    special_use = \\Archive
    auto = subscribe
  }
}
plugin {
  quota = maildir:User quota
  quota_rule = *:storage=200M
}
protocol imap {
  mail_plugins = $mail_plugins imap_quota
  imap_capability = +SPECIAL-USE
}
service imap-login {
  inet_listener imap {
    port = ${PORTS.imap}
  }
  inet_listener imaps {
    port = ${PORTS.imaps}
    ssl = yes
  }
}
service lmtp {
  inet_listener lmtp {
    address = 127.0.0.1
    port = ${PORTS.lmtp}
  }
}
service anvil {
  chroot =
}
service imap-login {
  chroot =
}
`
}

async function waitPort(port, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ok = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => (s.destroy(), res(true)))
      s.once('error', () => res(false))
    })
    if (ok) return
    await sleep(100)
  }
  throw new Error(`port ${port} sa neotvoril`)
}

function startSmtp({ key, cert }) {
  const lmtp = nodemailer.createTransport({ host: '127.0.0.1', port: PORTS.lmtp, lmtp: true, secure: false, ignoreTLS: true })
  const servers = []
  const options = (secure) => ({
    secure,
    key: readFileSync(key),
    cert: readFileSync(cert),
    authMethods: ['PLAIN', 'LOGIN'],
    banner: 'Doar test SMTP',
    size: 50 * 1024 * 1024,
    onAuth(auth, _session, cb) {
      const ok = USERS.some((u) => `${u.name}@${TEST_DOMAIN}` === auth.username) && auth.password === TEST_PASSWORD
      cb(ok ? null : Object.assign(new Error('Invalid credentials'), { responseCode: 535 }), ok ? { user: auth.username } : undefined)
    },
    onRcptTo(addr, _session, cb) {
      const a = addr.address.toLowerCase()
      if (a === `zlyhanie@${TEST_DOMAIN}`) return cb(Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }))
      cb()
    },
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', (c) => chunks.push(c))
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks)
        const rcpts = session.envelope.rcptTo.map((r) => r.address.toLowerCase())
        const drop = rcpts.find((r) => r === `prerusenie@${TEST_DOMAIN}` || r === `prijate-prerusenie@${TEST_DOMAIN}`)
        const local = rcpts.filter((r) => r.endsWith(`@${TEST_DOMAIN}`) && USERS.some((u) => `${u.name}@${TEST_DOMAIN}` === r))
        try {
          if (local.length && drop !== `prerusenie@${TEST_DOMAIN}`) {
            await lmtp.sendMail({ envelope: { from: session.envelope.mailFrom?.address || '', to: local }, raw })
          }
        } catch (e) {
          return cb(Object.assign(new Error(`Delivery failed: ${e.message}`), { responseCode: 452 }))
        }
        if (drop) {
          // Nejasný výsledok: DATA prijaté, odpoveď nikdy nepríde – spojenie sa natvrdo zavrie.
          for (const srv of servers) {
            for (const conn of srv.connections) if (conn.id === session.id) conn._socket?.destroy()
          }
          return
        }
        cb(null, 'Message queued as doar-test')
      })
    }
  })
  const plain = new SMTPServer(options(false))
  const tls = new SMTPServer(options(true))
  servers.push(plain, tls)
  for (const srv of servers) srv.on('error', () => {})
  plain.listen(PORTS.smtp, '127.0.0.1')
  tls.listen(PORTS.smtps, '127.0.0.1')
  return { plain, tls, lmtp }
}

/**
 * Spustí testovací server. `fresh: true` zmaže všetku poštu z predošlého behu.
 * Vráti informácie pre testy a funkciu stop().
 */
export async function startTestServer({ dir: dirOpt = '.testserver', fresh = true } = {}) {
  const dir = resolve(dirOpt)
  if (fresh && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  for (const d of ['run', 'state', 'mail']) mkdirSync(join(dir, d), { recursive: true })
  const certs = makeCert(dir)
  const conf = join(dir, 'dovecot.conf')
  writeFileSync(conf, dovecotConfig(dir, certs))
  const dovecot = spawn(findDovecot(), ['-F', '-c', conf], { stdio: ['ignore', 'inherit', 'inherit'] })
  let exited = false
  dovecot.on('exit', () => (exited = true))
  try {
    await waitPort(PORTS.imap)
    await waitPort(PORTS.lmtp)
  } catch (e) {
    const log = existsSync(join(dir, 'dovecot.log')) ? readFileSync(join(dir, 'dovecot.log'), 'utf8').slice(-2000) : ''
    dovecot.kill()
    throw new Error(`${e.message}\n${log}`)
  }
  const smtp = startSmtp(certs)
  await waitPort(PORTS.smtp)
  await waitPort(PORTS.smtps)

  return {
    dir,
    ca: readFileSync(certs.cert),
    host: '127.0.0.1',
    ports: PORTS,
    password: TEST_PASSWORD,
    user: (name) => `${name}@${TEST_DOMAIN}`,
    async stop() {
      await new Promise((r) => smtp.plain.close(r))
      await new Promise((r) => smtp.tls.close(r))
      smtp.lmtp.close()
      if (!exited) {
        dovecot.kill('SIGTERM')
        await new Promise((r) => (exited ? r() : dovecot.once('exit', r)))
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startTestServer({ fresh: !process.argv.includes('--keep') })
  console.log(`Testovací server beží.
  IMAP  ${s.host}:${PORTS.imap} (STARTTLS), ${s.host}:${PORTS.imaps} (TLS)
  SMTP  ${s.host}:${PORTS.smtp} (STARTTLS), ${s.host}:${PORTS.smtps} (TLS)
  Kontá alice|bob|carol|plna@${TEST_DOMAIN}, heslo ${TEST_PASSWORD}
  Certifikát (self-signed): ${join(s.dir, 'cert.pem')}
Ukončenie: Ctrl+C`)
  const stop = async () => {
    await s.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
