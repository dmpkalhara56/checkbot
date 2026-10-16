const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { execFile } = require('child_process')
const pino = require('pino')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys')

// ---------- Config ----------
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/\D/g, '') // 94771234567
const SESSION_B64 = process.env.SESSION_B64 || ''
const AUTH_DIR = process.env.AUTH_DIR || './auth'
const COOKIES_FILE = process.env.COOKIES_FILE || './cookies.txt'
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 90) // above this -> sent as document
const MAX_FILESIZE = process.env.MAX_FILESIZE || '200M'      // yt-dlp hard limit
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || 2)
const PENDING_TTL_MS = 5 * 60 * 1000
const EXTRA_ARGS = (process.env.YTDLP_EXTRA_ARGS || '').split(' ').filter(Boolean)
const PORT = Number(process.env.PORT || 8000)
const PAIR_PASSWORD = process.env.PAIR_PASSWORD || ''
const ALLOWED = (process.env.ALLOWED_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean)

const YT_REGEX = /(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\/\S+/i

// botMsgId -> { url, createdAt }
const pending = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [id, v] of pending) if (now - v.createdAt > PENDING_TTL_MS) pending.delete(id)
}, 60 * 1000)

// ---------- Tiny semaphore ----------
let running = 0
const waiters = []
async function acquire() {
  if (running < MAX_PARALLEL) { running++; return }
  await new Promise(r => waiters.push(r))
  running++
}
function release() {
  running--
  const next = waiters.shift()
  if (next) next()
}

// ---------- yt-dlp ----------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 20, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().slice(-500)))
      resolve(stdout)
    })
  })
}

async function download(url, type) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-'))
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--max-filesize', MAX_FILESIZE,
    '-P', dir,
    '-o', '%(title).60s.%(ext)s',
    ...EXTRA_ARGS
  ]
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE)

  if (type === 'mp3') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0')
  } else {
    args.push(
      '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[ext=mp4]/b',
      '--merge-output-format', 'mp4'
    )
  }
  args.push(url)

  await run('yt-dlp', args)

  const files = fs.readdirSync(dir)
  if (!files.length) throw new Error('No file produced (maybe over size limit)')
  const file = files[0]
  return { dir, filePath: path.join(dir, file), title: path.parse(file).name }
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

// ---------- Session restore ----------
function restoreSession() {
  const credsPath = path.join(AUTH_DIR, 'creds.json')
  if (SESSION_B64 && !fs.existsSync(credsPath)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    fs.writeFileSync(credsPath, Buffer.from(SESSION_B64, 'base64').toString('utf8'))
    console.log('Session restored from SESSION_B64')
  }
}

// ---------- Bot ----------
let sessionPrinted = false
let currentSock = null
let connected = false
let sockReady = Promise.resolve()
let markReady = () => {}

async function start() {
  restoreSession()
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false
  })

  currentSock = sock
  connected = false
  sockReady = new Promise(resolve => { markReady = resolve })
  setTimeout(() => markReady(), 8000) // fallback if no qr event arrives

  if (!sock.authState.creds.registered) {
    if (PHONE_NUMBER) {
      // Optional: auto request code for PHONE_NUMBER env (shown in logs)
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(PHONE_NUMBER)
          console.log('PAIRING CODE:', code)
        } catch (e) {
          console.error('Failed to get pairing code:', e.message)
        }
      }, 4000)
    } else {
      console.log('Not paired yet. Open the web page and enter your WhatsApp number.')
    }
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) markReady()
    if (connection === 'open') {
      connected = true
      console.log('✅ Connected to WhatsApp')
      if (!SESSION_B64 && !sessionPrinted) {
        sessionPrinted = true
        try {
          const b64 = fs.readFileSync(path.join(AUTH_DIR, 'creds.json')).toString('base64')
          console.log('\n--- SESSION_B64 (save this as an env variable so you do not need to pair again; keep it SECRET) ---')
          console.log(b64)
          console.log('--- END SESSION_B64 ---\n')
        } catch {}
      }
    }
    if (connection === 'close') {
      connected = false
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out. Delete the auth folder / SESSION_B64 and pair again.')
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        process.exit(1)
      }
      console.log('Connection closed, reconnecting...', code)
      setTimeout(start, 3000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const m = messages[0]
    if (!m?.message || m.key.fromMe) return

    const from = m.key.remoteJid
    if (from === 'status@broadcast') return

    if (ALLOWED.length) {
      const sender = (m.key.participant || from).split('@')[0]
      if (!ALLOWED.includes(sender)) return
    }

    const text = (
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ''
    ).trim()
    const quotedId = m.message.extendedTextMessage?.contextInfo?.stanzaId

    try {
      // 1) Reply "1" / "2" to our menu message
      if (quotedId && pending.has(quotedId) && (text === '1' || text === '2')) {
        const { url } = pending.get(quotedId)
        pending.delete(quotedId)
        const type = text === '1' ? 'mp4' : 'mp3'

        await sock.sendMessage(from, { text: '⏳ Download වෙනවා... පොඩ්ඩක් ඉන්න' }, { quoted: m })

        await acquire()
        let job
        try {
          job = await download(url, type)
          const sizeMB = fs.statSync(job.filePath).size / 1024 / 1024

          if (type === 'mp3') {
            await sock.sendMessage(from, {
              audio: { url: job.filePath },
              mimetype: 'audio/mpeg',
              fileName: job.title + '.mp3'
            }, { quoted: m })
          } else if (sizeMB > MAX_VIDEO_MB) {
            await sock.sendMessage(from, {
              document: { url: job.filePath },
              mimetype: 'video/mp4',
              fileName: job.title + '.mp4'
            }, { quoted: m })
          } else {
            await sock.sendMessage(from, {
              video: { url: job.filePath },
              mimetype: 'video/mp4',
              caption: job.title
            }, { quoted: m })
          }
        } finally {
          release()
          if (job) cleanup(job.dir)
        }
        return
      }

      // 2) YouTube link -> show menu
      const match = text.match(YT_REGEX)
      if (match) {
        let url = match[0]
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url
        const sent = await sock.sendMessage(from, {
          text: 'ඕන ෆෝමැට් එක තෝරන්න (මේ message එකට reply කරලා number එක දාන්න):\n\n1️⃣ MP4 🎬 (Video)\n2️⃣ MP3 🎵 (Audio)'
        }, { quoted: m })
        pending.set(sent.key.id, { url, createdAt: Date.now() })
      }
    } catch (e) {
      console.error('Error:', e.message)
      await sock.sendMessage(from, { text: '❌ Download කරන්න බැරි වුණා. පස්සෙ උත්සාහ කරන්න.' }, { quoted: m }).catch(() => {})
    }
  })
}


// ---------- Pairing web page ----------
const PAIR_HTML_PATH = path.join(__dirname, 'pair.html')
const pairHits = []

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > 10000) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') {
      return json(res, 200, {
        registered: !!currentSock?.authState?.creds?.registered,
        connected,
        needsPassword: !!PAIR_PASSWORD
      })
    }

    if (req.method === 'POST' && req.url === '/pair') {
      // rate limit: 5 requests / minute
      const now = Date.now()
      while (pairHits.length && now - pairHits[0] > 60000) pairHits.shift()
      if (pairHits.length >= 5) return json(res, 429, { error: 'Too many attempts, wait a minute.' })
      pairHits.push(now)

      const body = await readBody(req)
      if (PAIR_PASSWORD && body.password !== PAIR_PASSWORD) return json(res, 401, { error: 'Wrong password' })
      if (!currentSock) return json(res, 503, { error: 'Bot is starting, try again in a few seconds' })
      if (currentSock.authState.creds.registered) return json(res, 400, { error: 'Already paired. Delete session to pair again.' })

      const number = String(body.number || '').replace(/\D/g, '')
      if (number.length < 8 || number.length > 15) return json(res, 400, { error: 'Invalid number' })

      await sockReady
      const raw = await currentSock.requestPairingCode(number)
      const code = raw.length === 8 ? raw.slice(0, 4) + '-' + raw.slice(4) : raw
      console.log('Pairing code requested for', number.slice(0, 4) + '****')
      return json(res, 200, { code })
    }

    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(fs.readFileSync(PAIR_HTML_PATH))
    }

    res.writeHead(404); res.end('Not found')
  } catch (e) {
    console.error('HTTP error:', e.message)
    json(res, 500, { error: 'Could not get code. Try again.' })
  }
}).listen(PORT, () => console.log('Pairing page on port', PORT))

process.on('unhandledRejection', e => console.error('unhandledRejection', e))
process.on('uncaughtException', e => console.error('uncaughtException', e))

start()
