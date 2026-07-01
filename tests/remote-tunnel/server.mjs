import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import process from 'node:process'
import { URL } from 'node:url'

const token = process.env.JEAN_TEST_TOKEN ?? 'test-token'

function textFrame(value) {
  const payload = Buffer.from(JSON.stringify(value))
  if (payload.length >= 126) {
    throw new Error('Test WebSocket payload is too large')
  }
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
}

function readClientFrame(buffer) {
  if (buffer.length < 6) return null
  const length = buffer[1] & 0x7f
  if (length >= 126 || buffer.length < 6 + length) return null

  const mask = buffer.subarray(2, 6)
  const payload = buffer.subarray(6, 6 + length)
  const decoded = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) {
    decoded[index] = payload[index] ^ mask[index % 4]
  }
  return JSON.parse(decoded.toString('utf8'))
}

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/api/auth' && url.searchParams.get('token') === token) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, app_version: 'test' }))
    return
  }

  response.writeHead(401)
  response.end()
})

server.on('upgrade', (request, socket) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== token) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }

  const key = request.headers['sec-websocket-key']
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n')
  )

  socket.write(
    textFrame({
      type: 'event',
      event: 'chat:chunk',
      payload: { session_id: 'session-test', content: 'first' },
      seq: 1,
    })
  )

  socket.on('data', data => {
    const message = readClientFrame(data)
    if (
      message?.type === 'replay' &&
      message.session_id === 'session-test' &&
      message.last_seq === 1
    ) {
      socket.write(
        textFrame({
          type: 'event',
          event: 'chat:chunk',
          payload: { session_id: 'session-test', content: 'replayed' },
          seq: 2,
        })
      )
    }
  })
})

server.listen(3456, '127.0.0.1')
