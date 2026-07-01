#!/usr/bin/env node
/* global AbortSignal, WebSocket, fetch */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const composeFile = resolve(root, 'tests/remote-tunnel/compose.yaml')
const projectName = `jean-tunnel-test-${process.pid}`
const token = 'test-token'
const temporaryDirectory = mkdtempSync(
  resolve(tmpdir(), 'jean-remote-tunnel-test-')
)
const privateKey = resolve(temporaryDirectory, 'id_ed25519')
const publicKey = `${privateKey}.pub`
const tunnelProcesses = new Set()
const socketStates = new WeakMap()

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.silent ? 'ignore' : 'inherit',
    env: options.env ?? process.env,
  })
}

async function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close(error => {
        if (error || port === null) reject(error ?? new Error('No port'))
        else resolvePort(port)
      })
    })
  })
}

function composeEnvironment(sshPort) {
  return {
    ...process.env,
    JEAN_TEST_SSH_PORT: String(sshPort),
    JEAN_TEST_AUTHORIZED_KEY: publicKey,
  }
}

function startTunnel(sshPort, localPort) {
  const child = spawn(
    'ssh',
    [
      '-N',
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-i',
      privateKey,
      '-p',
      String(sshPort),
      '-L',
      `127.0.0.1:${localPort}:127.0.0.1:3456`,
      'jean@127.0.0.1',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  child.stderrText = ''
  child.stderr.on('data', data => {
    child.stderrText += data.toString()
  })
  tunnelProcesses.add(child)
  child.once('exit', () => tunnelProcesses.delete(child))
  return child
}

async function waitForHealth(port, tunnel) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/auth?token=${token}`
      )
      if (response.ok) return
    } catch {
      // Tunnel is not ready yet.
    }
    if (tunnel.exitCode !== null) {
      throw new Error(`SSH tunnel exited: ${tunnel.stderrText.trim()}`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`Tunnel on port ${port} did not become healthy`)
}

async function expectHealthFailure(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/auth?token=${token}`, {
      signal: AbortSignal.timeout(1_000),
    })
  } catch {
    return
  }
  throw new Error(`Tunnel on port ${port} remained reachable after termination`)
}

function connectWebSocket(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
  const state = { messages: [], waiters: new Set() }
  socketStates.set(socket, state)
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    state.messages.push(message)
    for (const waiter of state.waiters) waiter(message)
  })
  return new Promise((resolveSocket, reject) => {
    socket.addEventListener('open', () => resolveSocket(socket), { once: true })
    socket.addEventListener(
      'error',
      () => reject(new Error('WebSocket connection failed')),
      { once: true }
    )
  })
}

function waitForSequence(socket, sequence) {
  const state = socketStates.get(socket)
  if (!state) throw new Error('WebSocket state was not initialized')
  const existing = state.messages.find(message => message.seq === sequence)
  if (existing) return Promise.resolve(existing)

  return new Promise((resolveEvent, reject) => {
    const listener = message => {
      if (message.seq !== sequence) return
      clearTimeout(timeout)
      state.waiters.delete(listener)
      resolveEvent(message)
    }
    const timeout = setTimeout(() => {
      state.waiters.delete(listener)
      reject(new Error(`Timed out waiting for sequence ${sequence}`))
    }, 5_000)
    state.waiters.add(listener)
  })
}

async function stopTunnel(child) {
  if (child.exitCode !== null) return
  child.kill('SIGKILL')
  await new Promise(resolveExit => child.once('exit', resolveExit))
}

async function cleanup(environment) {
  for (const child of tunnelProcesses) {
    child.kill('SIGKILL')
  }
  try {
    run(
      'docker',
      [
        'compose',
        '-p',
        projectName,
        '-f',
        composeFile,
        'down',
        '--volumes',
        '--remove-orphans',
      ],
      { env: environment, silent: true }
    )
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

async function main() {
  const sshPort = await reservePort()
  const firstLocalPort = await reservePort()
  const secondLocalPort = await reservePort()
  const environment = composeEnvironment(sshPort)

  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', privateKey], {
    silent: true,
  })

  try {
    run(
      'docker',
      [
        'compose',
        '-p',
        projectName,
        '-f',
        composeFile,
        'up',
        '--detach',
        '--build',
        '--wait',
      ],
      { env: environment }
    )

    const firstTunnel = startTunnel(sshPort, firstLocalPort)
    await waitForHealth(firstLocalPort, firstTunnel)
    const firstSocket = await connectWebSocket(firstLocalPort)
    await waitForSequence(firstSocket, 1)

    await stopTunnel(firstTunnel)
    await expectHealthFailure(firstLocalPort)

    const secondTunnel = startTunnel(sshPort, secondLocalPort)
    await waitForHealth(secondLocalPort, secondTunnel)
    const secondSocket = await connectWebSocket(secondLocalPort)
    await waitForSequence(secondSocket, 1)
    const replay = waitForSequence(secondSocket, 2)
    secondSocket.send(
      JSON.stringify({
        type: 'replay',
        session_id: 'session-test',
        last_seq: 1,
      })
    )
    const replayedEvent = await replay
    if (replayedEvent.payload?.content !== 'replayed') {
      throw new Error('Unexpected replay payload')
    }

    firstSocket.close()
    secondSocket.close()
    await stopTunnel(secondTunnel)
    console.log('Remote tunnel recovery integration test passed.')
  } finally {
    await cleanup(environment)
  }
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
