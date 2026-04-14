/**
 * Local creation server.
 * Run with: npm run create
 *
 * Opens a browser at http://localhost:4321 where you can:
 *  1. Compose a message
 *  2. Pick an existing template or upload a new image + draw the rip line
 *  3. Encrypt the message and write it to messages/{id}.json
 *  4. Get the shareable URL to copy and send
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { generateKey, encryptMessage } from '../crypto-node.js'
import { openBrowser } from './open-browser.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const PORT = 4321

// Read GitHub Pages base URL from package.json homepage field, or derive from git remote
async function getPagesBase(): Promise<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { homepage?: string }
    if (pkg.homepage) return pkg.homepage.replace(/\/$/, '')
  } catch { /* ignore */ }
  return `https://YOUR_USERNAME.github.io/message-for-you`
}

function listTemplates(): string[] {
  const templatesDir = path.join(ROOT, 'public', 'templates')
  if (!fs.existsSync(templatesDir)) return []
  return fs.readdirSync(templatesDir).filter((d) =>
    fs.statSync(path.join(templatesDir, d)).isDirectory(),
  )
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  // ── POST /api/create ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/create') {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    await new Promise<void>((r) => req.on('end', r))

    type CreateBody = { message: string; templateId: string }
    const { message, templateId } = JSON.parse(body) as CreateBody

    const { keyB64 } = await generateKey()
    const { ciphertext, iv } = await encryptMessage(message, keyB64)
    const id = randomUUID()
    const envelope = { ciphertext, iv, templateId, createdAt: new Date().toISOString() }

    const messagesDir = path.join(ROOT, 'public', 'messages')
    if (!fs.existsSync(messagesDir)) fs.mkdirSync(messagesDir, { recursive: true })
    fs.writeFileSync(path.join(messagesDir, `${id}.json`), JSON.stringify(envelope, null, 2))

    const base = await getPagesBase()
    const shareUrl = `${base}/#${id}:${keyB64}`

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id, shareUrl }))
    return
  }

  // ── GET /api/templates ───────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/templates') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(listTemplates()))
    return
  }

  // ── POST /api/save-template ──────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/save-template') {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    await new Promise<void>((r) => req.on('end', r))

    type SaveTemplateBody = {
      id: string
      imageDataUrl: string
      ripLine: [number, number][]
      jagStyle: 'straight' | 'light' | 'heavy'
    }
    const { id, imageDataUrl, ripLine, jagStyle } = JSON.parse(body) as SaveTemplateBody

    const dir = path.join(ROOT, 'public', 'templates', id)
    fs.mkdirSync(dir, { recursive: true })

    // decode data URL → PNG file
    const [, b64] = imageDataUrl.split(',')
    fs.writeFileSync(path.join(dir, 'cover.png'), Buffer.from(b64, 'base64'))

    const config = { id, image: 'cover.png', ripLine, jagStyle }
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // ── GET / (serve UI) ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
    return
  }

  res.writeHead(404)
  res.end('not found')
})

server.listen(PORT, () => {
  const addr = `http://localhost:${PORT}`
  console.log(`\n  Message creator running at ${addr}\n`)
  openBrowser(addr)
})
