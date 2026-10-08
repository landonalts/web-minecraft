#!/usr/bin/env node
/*
 * Standalone proxy for the web Minecraft client.
 * Bridges browser WebSocket connections to:
 *   1. TCP  - normal Java servers, e.g.  { "host": "play.donutsmp.net", "port": 25565 }
 *   2. WS   - WebSocket servers, e.g.    { "host": "wss://top.bagelsmp.com", "port": 25565 }
 *
 * Protocol (compatible with net-browserify clients):
 *   POST /api/vm/net/connect   {host, port} -> {token, remote}  (or {code, error})
 *   WS   /api/vm/net/socket?token=<token>                        -> raw packet pipe
 *   GET  /api/vm/net/connect                                     -> health check JSON
 *   WS   /api/vm/net/ping                                       -> ping:/pong: endpoint
 *
 * Run:  node proxy.js [--port 8081]
 * Serves ./public/ statically if that folder exists (drop the built frontend in there).
 */

const http = require('http')
const net = require('net')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { WebSocketServer, WebSocket } = require('ws')

const args = process.argv.slice(2)
const portFlag = args.indexOf('--port')
const PORT = Number(process.env.PORT || (portFlag !== -1 ? args[portFlag + 1] : 8081)) || 8081
const URL_ROOT = '/api/vm/net'

const pending = new Map() // token -> { kind: 'tcp', socket } | { kind: 'ws', ws }

function makeToken () {
  return crypto.randomBytes(32).toString('hex')
}

function sendJson (res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// --- tiny static file server for ./public (optional) ---
const PUBLIC_DIR = path.join(__dirname, 'public')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain', '.map': 'application/json' }

function serveStatic (req, res) {
  if (!fs.existsSync(PUBLIC_DIR)) return false
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/index.html'
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([/\\])+/, ''))
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp'
  })
  fs.createReadStream(file).pipe(res)
  return true
}

const STATUS_PAGE = `<!DOCTYPE html><html><head><title>Proxy</title></head><body style="background:#111;color:#eee;font-family:monospace;padding:40px">
<h2>Minecraft web proxy is running</h2>
<p>Set this address as the <b>Proxy</b> in the client:</p>
<p style="font-size:18px;color:#8f8">http://YOUR-PC-IP:${PORT}</p>
<p>Health check: <a style="color:#8af" href="${URL_ROOT}/connect">${URL_ROOT}/connect</a></p>
</body></html>`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')

  // CORS preflight
  if (req.method === 'OPTIONS' && url.pathname.startsWith(URL_ROOT)) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '1728000'
    })
    return res.end()
  }

  if (req.method === 'GET' && url.pathname === `${URL_ROOT}/connect`) {
    return sendJson(res, 200, { code: 200, description: 'A proxy server for Minecraft web clients', time: Date.now() })
  }

  if (req.method === 'POST' && url.pathname === `${URL_ROOT}/connect`) {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return sendJson(res, 400, { code: 400, error: 'Invalid JSON body' })
    }
    const host = body.host
    const port = Number(body.port) || 25565
    if (!host) return sendJson(res, 400, { code: 400, error: 'No host and port specified' })

    const token = makeToken()

    // --- mode 2: target is itself a WebSocket server (ws:// / wss://) ---
    if (/^wss?:\/\//i.test(host)) {
      const targetUrl = host
      console.log(`[proxy] WS passthrough requested -> ${targetUrl}`)
      let target
      try {
        target = new WebSocket(targetUrl)
      } catch (err) {
        return sendJson(res, 502, { code: 502, error: 'Socket error: ' + err.message })
      }
      const openTimer = setTimeout(() => {
        try { target.close() } catch {}
        if (!res.writableEnded) sendJson(res, 504, { code: 504, error: `Timed out connecting to ${targetUrl}` })
      }, 8000)
      target.on('open', () => {
        clearTimeout(openTimer)
        if (res.writableEnded) { try { target.close() } catch {}; return }
        pending.set(token, { kind: 'ws', ws: target })
        console.log(`[proxy] WS tunnel open ${targetUrl} (${token.slice(0, 8)}…)`)
        sendJson(res, 200, { token, remote: { address: targetUrl, family: 4, port: 0 } })
      })
      target.on('error', (err) => {
        clearTimeout(openTimer)
        pending.delete(token)
        if (!res.writableEnded) sendJson(res, 502, { code: 502, error: 'Socket error: ' + (err.message || err.code || 'unknown') })
      })
      return
    }

    // --- mode 1: normal TCP Java server ---
    console.log(`[proxy] TCP requested -> ${host}:${port}`)
    const socket = net.connect({ host, port, timeout: 8000 }, () => {
      pending.set(token, { kind: 'tcp', socket })
      console.log(`[proxy] TCP connected ${host}:${port} (${token.slice(0, 8)}…)`)
      const remote = socket.address()
      sendJson(res, 200, { token, remote: { address: remote.address, family: remote.family === 'IPv6' ? 6 : 4, port: remote.port } })
    })
    socket.on('timeout', () => {
      socket.destroy()
      if (!res.writableEnded) sendJson(res, 504, { code: 504, error: `Socket timed out. Ensure ${host}:${port} is reachable.` })
    })
    socket.on('error', (err) => {
      if (!res.writableEnded) sendJson(res, 502, { code: 502, error: 'Socket error: ' + (err.code || err.message) })
    })
    return
  }

  if (serveStatic(req, res)) return
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && !fs.existsSync(PUBLIC_DIR)) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(STATUS_PAGE)
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code: 404, error: 'Not found' }))
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === `${URL_ROOT}/ping`) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const s = data.toString()
        if (s.startsWith('ping:')) ws.send('pong:' + s.slice(5))
      })
    })
    return
  }
  if (url.pathname === `${URL_ROOT}/socket`) {
    const token = url.searchParams.get('token')
    const entry = pending.get(token)
    if (!entry) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      return socket.destroy()
    }
    pending.delete(token)
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      console.log(`[proxy] tunnel attached (${token.slice(0, 8)}…, ${entry.kind})`)
      if (entry.kind === 'tcp') {
        const tcp = entry.socket
        tcp.setTimeout(0)
        clientWs.on('message', (data) => {
          if (typeof data === 'string' && data.startsWith('ping:')) return clientWs.send('pong:' + data.slice(5))
          tcp.write(data)
        })
        tcp.on('data', (data) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data) })
        const closeBoth = () => { try { tcp.destroy() } catch {}; try { clientWs.close() } catch {} }
        clientWs.on('close', closeBoth)
        tcp.on('close', closeBoth)
        tcp.on('error', closeBoth)
        clientWs.on('error', closeBoth)
      } else {
        const target = entry.ws
        const forward = (from, to) => (data) => {
          if (typeof data === 'string' && data.startsWith('ping:')) return from.send('pong:' + data.slice(5))
          if (to.readyState === WebSocket.OPEN) to.send(data, { binary: !(typeof data === 'string') })
        }
        clientWs.on('message', forward(clientWs, target))
        target.on('message', forward(target, clientWs))
        const closeBoth = () => { try { target.close() } catch {}; try { clientWs.close() } catch {} }
        clientWs.on('close', closeBoth)
        target.on('close', closeBoth)
        clientWs.on('error', closeBoth)
        target.on('error', closeBoth)
      }
    })
    return
  }
  socket.destroy()
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] listening on 0.0.0.0:${PORT}`)
  console.log(`[proxy] health: http://localhost:${PORT}${URL_ROOT}/connect`)
})
