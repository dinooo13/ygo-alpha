// Startup file for Plesk's Node.js (Phusion Passenger). Passenger needs a
// CommonJS entry; the Nitro server is ESM, so it is loaded with import().
const fs = require('node:fs')
const path = require('node:path')

process.chdir(__dirname)
process.env.NODE_ENV = 'production'

// Passenger's own log isn't reachable over SSH; keep startup errors here.
function logFailure(label, err) {
  const line = `[${new Date().toISOString()}] ${label}: ${err && err.stack ? err.stack : err}\n`
  try {
    fs.appendFileSync(path.join(__dirname, 'tmp', 'startup.log'), line)
  }
  catch {
    // Best effort: stderr below still gets the line.
  }
  console.error(line)
}
process.on('uncaughtException', err => logFailure('uncaughtException', err))
process.on('unhandledRejection', err => logFailure('unhandledRejection', err))

try {
  // Settings live in .env next to this file (Node >= 20.12). Variables set in
  // the Plesk panel take precedence.
  process.loadEnvFile(path.join(__dirname, '.env'))
}
catch (err) {
  logFailure('loadEnvFile', err)
}

import('./.output/server/index.mjs').catch((err) => {
  logFailure('Failed to start', err)
  process.exit(1)
})
