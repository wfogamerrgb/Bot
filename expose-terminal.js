'use strict'

const fs = require('fs')
const crypto = require('crypto')
const { Client } = require('ssh2')

function envFlag(value, fallback = false) {
  if (value === undefined) return fallback
  return /^(1|true|yes|on)$/i.test(String(value).trim())
}

function sshConfig(env = process.env) {
  return {
    enabled: envFlag(env.SSH, false),
    host: env.SSH_HOST || 'host.docker.internal',
    port: Number.parseInt(env.SSH_PORT || '22', 10),
    username: env.SSH_USER || '',
    password: env.SSH_PASSWORD || '',
    privateKey: env.SSH_PRIVATE_KEY || '',
    privateKeyFile: env.SSH_PRIVATE_KEY_FILE || '',
    passphrase: env.SSH_KEY_PASSPHRASE || '',
    hostKeyFingerprint: env.SSH_HOST_KEY_FINGERPRINT || '',
    skipHostKeyVerification: envFlag(env.SSH_SKIP_HOST_KEY_VERIFY, false),
    readyTimeout: Number.parseInt(env.SSH_READY_TIMEOUT_MS || '10000', 10)
  }
}

function createTerminal(options = {}) {
  const config = { ...sshConfig(), ...options }
  const client = new Client()
  let stream = null
  let closed = false
  const dataHandlers = []
  const closeHandlers = []
  let closeNotified = false

  const notifyClose = () => {
    if (closeNotified) return
    closeNotified = true
    closed = true
    closeHandlers.forEach(handler => { try { handler() } catch (_) {} })
  }

  const terminal = {
    connect() {
      return new Promise((resolve, reject) => {
        if (!config.enabled) {
          reject(new Error('SSH terminal is disabled'))
          return
        }
        if (!config.username) {
          reject(new Error('SSH_USER is not configured'))
          return
        }
        if (!config.skipHostKeyVerification && !config.hostKeyFingerprint) {
          reject(new Error('SSH_HOST_KEY_FINGERPRINT is not configured'))
          return
        }

        const onReady = () => {
          client.shell({ term: 'xterm-256color', rows: 40, cols: 120 }, (err, shell) => {
            if (err) {
              client.end()
              reject(err)
              return
            }
            stream = shell
            
  stream.setEncoding('utf8')
            stream.once('close',()=>{
notifyClose()
              try {client.end() } catch (_) {}
            })
dataHandlers.forEach(handler =>{
stream.on('data',handler)
stream.stderr?.on('data',handler)
  
})
            
            resolve(terminal)
          })
        }

        client.once('ready', onReady)
        client.once('error', reject)
        client.once('close', notifyClose)
        let privateKey = config.privateKey || ''
        if (!privateKey && config.privateKeyFile) {
          try { privateKey = fs.readFileSync(config.privateKeyFile, 'utf8') } catch (err) {
            reject(new Error(`SSH private key could not be read: ${err.message}`))
            return
          }
        }

        client.connect({
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password || undefined,
          privateKey: privateKey || undefined,
          passphrase: config.passphrase || undefined,
          hostVerifier: config.skipHostKeyVerification
            ? undefined
            : key => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === config.hostKeyFingerprint,
          readyTimeout: config.readyTimeout,
          tryKeyboard: false
        })
      })
    },
    onData(handler) {
      dataHandlers.push(handler)
      if (stream) {
        stream.on('data', handler)
        stream.stderr?.on('data', handler)
      }
      return terminal
    },
    onClose(handler) {
      closeHandlers.push(handler)
      return terminal
    },
    write(data) {
      if (!stream || closed) return false
      return stream.write(data)
    },
    resize(cols, rows) {
      if (!stream || closed || typeof stream.setWindow !== 'function') return false
      stream.setWindow(rows, cols, 0, 0)
      return true
    },
    close() {
      if (closed) return
      closed = true
      try { stream?.end('exit\n') } catch (_) {}
      try { client.end() } catch (_) {}
      stream = null
    }
  }

  return terminal
}

module.exports = { createTerminal, sshConfig, envFlag }
