import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createServer } from 'vite'
import { S3Client } from '@aws-sdk/client-s3'

const profile = {
  profileId: 'profile',
  enabled: true,
  maxFileBytes: null,
  maxStorageBytes: null,
  rules: [{ path: 'saves/**', action: 'INCLUDE', enabled: true }]
}
const player = { id: 'player-a', minecraftUuid: 'a'.repeat(32) }
let files, states, uploads, used, reserved
const originalSend = S3Client.prototype.send
S3Client.prototype.send = async () => ({ ContentLength: 5, ChecksumSHA256: Buffer.from('a'.repeat(64), 'hex').toString('base64') })
const db = {
  player: { findUnique: async ({ where }) => (where.id === player.id ? player : null) },
  profile: { findUnique: async () => ({ id: 'profile' }) },
  syncProfile: { findUnique: async () => profile },
  maintenance: { findUnique: async () => null },
  playerDevice: {
    findUnique: async ({ where }) =>
      where.playerId_deviceUuid.playerId === player.id && where.playerId_deviceUuid.deviceUuid === 'device-a'
        ? { id: 'device-db', playerId: player.id }
        : null,
    update: async () => ({})
  },
  syncFile: {
    findUnique: async ({ where }) =>
      files.find((f) => Object.entries(where.playerId_profileId_path).every(([key, value]) => f[key] === value)) ?? null,
    findMany: async ({ where }) => files.filter((f) => f.playerId === where.playerId && f.profileId === where.profileId),
    aggregate: async () => ({ _sum: { size: used } }),
    update: async ({ where, data }) => {
      const file = files.find((f) => f.id === where.id)
      const version = file.version + (data.version.increment ?? 0)
      Object.assign(file, data, { version })
      return file
    }
  },
  playerSyncState: {
    findUnique: async () => ({ revision: states }),
    upsert: async () => ({ revision: ++states })
  },
  syncUpload: {
    aggregate: async () => ({ _sum: { reservedBytes: reserved } }),
    create: async ({ data }) => {
      const row = { id: 'upload', ...data }
      uploads.push(row)
      return row
    },
    findFirst: async ({ where }) => uploads.find((f) => Object.entries(where).every(([key, value]) => f[key] === value)) ?? null
  },
  s3Configuration: { findUnique: async () => null },
  syncMetric: { upsert: async () => ({}) },
  $executeRaw: async () => 1,
  $transaction: async (callback) => callback(db)
}
globalThis.__syncTestDb = db
const vite = await createServer({
  configFile: false,
  ssr: { external: ['@prisma/client', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner', 'jose'] },
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
  resolve: { alias: { $lib: path.resolve('src/lib') } },
  plugins: [
    {
      name: 'sync-test-db',
      enforce: 'pre',
      resolveId(source) {
        if (source === '$lib/server/db' || source === './db' || source.endsWith('/server/db')) return '\0sync-test-db'
        if (source === '$app/environment') return '\0sync-test-env'
      },
      load(id) {
        if (id === '\0sync-test-db') return 'export const db = globalThis.__syncTestDb'
        if (id === '\0sync-test-env') return 'export const building = true'
      }
    }
  ]
})
const api = await vite.ssrLoadModule('/src/lib/server/sync-api.ts')
const sync = await vite.ssrLoadModule('/src/lib/server/sync.ts')
const route = await vite.ssrLoadModule('/src/routes/api/sync/profiles/[profileId]/[...operation]/+server.ts')
const prepare = await vite.ssrLoadModule('/src/lib/server/sync-upload.ts')
const commit = await vite.ssrLoadModule('/src/routes/api/sync/profiles/[profileId]/upload/[uploadId]/commit/+server.ts')
const maintenance = await vite.ssrLoadModule('/src/lib/server/sync-maintenance.ts')
after(async () => {
  S3Client.prototype.send = originalSend
  delete globalThis.__syncTestDb
  await vite.close()
})
beforeEach(() => {
  files = []
  states = 0n
  uploads = []
  used = 0n
  reserved = 0n
  profile.enabled = true
  profile.maxStorageBytes = null
  process.env.SYNC_S3_ENDPOINT = 'http://localhost:9000'
  process.env.SYNC_S3_REGION = 'test'
  process.env.SYNC_S3_BUCKET = 'sync-test'
  process.env.SYNC_S3_ACCESS_KEY = 'test-key'
  process.env.SYNC_S3_SECRET_KEY = 'test-secret'
  process.env.SYNC_ENABLED = 'true'
  process.env.JWT_SECRET_KEY = 'sync-test-key-'.repeat(4)
})
const input = { path: 'saves/level.dat', hash: `sha256:${'a'.repeat(64)}`, size: 5n, baseVersion: null, deviceId: 'device-a' }
const row = () => ({
  id: 'file',
  playerId: player.id,
  profileId: 'profile',
  path: input.path,
  hash: input.hash,
  size: 5n,
  version: 1,
  deleted: false,
  objectKey: 'key',
  updatedAt: new Date()
})
async function event(operation, method = 'GET', body, authenticated = true) {
  const headers = body ? { 'Content-Type': 'application/json' } : {}
  if (authenticated) headers.Authorization = `Bearer ${(await sync.createSyncPlayerToken(player.id)).token}`
  const url = new URL(`http://localhost/api/sync/profiles/profile/${operation}`)
  return {
    params: { profileId: 'profile', operation: operation.split('?')[0] },
    url,
    request: new Request(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
  }
}

test('all reads require a verified player; manifest is scoped to that player', async () => {
  assert.equal((await route.GET(await event('manifest', 'GET', undefined, false))).status, 401)
  files = [row(), { ...row(), id: 'other', playerId: 'player-b', path: 'saves/private.dat' }]
  const response = await route.GET(await event('manifest'))
  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys((await response.json()).files), ['saves/level.dat'])
})
test('revision and empty manifest do not need S3', async () => {
  assert.deepEqual(await (await route.GET(await event('revision'))).json(), { revision: '0' })
  assert.deepEqual((await (await route.GET(await event('manifest'))).json()).files, {})
})
test('pagination rejects a stale revision, paths must match explicit rules', async () => {
  states = 2n
  assert.equal((await route.GET(await event('manifest?revision=1'))).status, 409)
  assert.equal((await route.POST(await event('download', 'POST', { path: 'config/private' }))).status, 403)
  assert.equal((await route.POST(await event('download', 'POST', { path: '../escape' }))).status, 400)
  assert.equal((await route.POST(await event('download/batch', 'POST', { paths: Array(101).fill('saves/a') }))).status, 400)
})
test('deletion checks ownership and base version, then increments tombstone and revision', async () => {
  files = [row()]
  await assert.rejects(api.deleteSyncFile(player.id, 'profile', { ...input, baseVersion: 1, deviceId: 'device-b' }), { code: 'DEVICE_NOT_FOUND' })
  await assert.rejects(api.deleteSyncFile(player.id, 'profile', { ...input, baseVersion: 2 }), { code: 'VERSION_CONFLICT' })
  assert.equal(files[0].deleted, false)
  const result = await api.deleteSyncFile(player.id, 'profile', { ...input, baseVersion: 1 })
  assert.equal(result.file.version, 2)
  assert.equal(result.file.deleted, true)
  assert.equal(result.revision, '1')
})
test('a player cannot commit another player upload', async () => {
  uploads = [{ id: 'upload', playerId: 'player-b', profileId: 'profile' }]
  const e = await event('upload/upload/commit', 'POST', {})
  e.params.uploadId = 'upload'
  assert.equal((await commit.POST(e)).status, 404)
})
test('disabled sync and denied paths are rejected before storage writes', async () => {
  process.env.SYNC_ENABLED = 'false'
  await assert.rejects(prepare.prepareSyncUpload(player.id, 'profile', input), { code: 'SYNC_DISABLED' })
  assert.equal(uploads.length, 0)
  assert.throws(() => sync.parseUploadRequest({ ...input, size: '5', baseVersion: 0 }), { code: 'INVALID_VERSION' })
})

test('quota reservations include pending uploads and replacement credits only the old size', async () => {
  profile.maxStorageBytes = 10n
  used = 7n
  reserved = 2n
  await assert.rejects(prepare.prepareSyncUpload(player.id, 'profile', input), { code: 'QUOTA_EXCEEDED' })
  assert.equal(uploads.length, 0)
  files = [row()]
  used = 5n
  reserved = 0n
  const result = await prepare.prepareSyncUpload(player.id, 'profile', { ...input, baseVersion: 1 })
  assert.equal(result.uploadRequired, false)
  assert.equal(uploads[0].reservedBytes, 0n)
  assert.equal(uploads[0].playerId, player.id)
})
test('storage HEAD failure cannot advance metadata or reserve an upload', async () => {
  const previousSend = S3Client.prototype.send
  S3Client.prototype.send = async () => {
    const error = new Error('storage offline')
    error.name = 'AccessDenied'
    error.$metadata = { httpStatusCode: 403 }
    throw error
  }
  try {
    await assert.rejects(prepare.prepareSyncUpload(player.id, 'profile', input), (error) => {
      assert.equal(error.code, 'SYNC_STORAGE_ERROR')
      assert.equal(error.details.operation, 'upload preflight')
      assert.equal(error.details.storageError, 'AccessDenied')
      assert.equal(error.details.httpStatusCode, 403)
      assert.match(error.message, /AccessDenied, HTTP 403/)
      return true
    })
    assert.equal(uploads.length, 0)
    assert.equal(states, 0n)
  } finally {
    S3Client.prototype.send = previousSend
  }
})

test('presigned uploads return all headers included in the signature', async () => {
  const previousSend = S3Client.prototype.send
  S3Client.prototype.send = async () => {
    const error = new Error('not found')
    error.name = 'NotFound'
    error.$metadata = { httpStatusCode: 404 }
    throw error
  }
  try {
    const result = await prepare.prepareSyncUpload(player.id, 'profile', input)
    const signedUrl = new URL(result.uploadUrl)
    assert.equal(result.uploadRequired, true)
    assert.equal(signedUrl.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host;x-amz-checksum-sha256')
    assert.equal(signedUrl.searchParams.has('x-amz-checksum-sha256'), false)
    assert.deepEqual(result.uploadHeaders, {
      'content-length': '5',
      'x-amz-checksum-sha256': Buffer.from('a'.repeat(64), 'hex').toString('base64')
    })
  } finally {
    S3Client.prototype.send = previousSend
  }
})

test('upload verification reports the storage failure details', async () => {
  const previousSend = S3Client.prototype.send
  S3Client.prototype.send = async () => {
    const error = new Error('storage offline')
    error.name = 'KMS.AccessDeniedException'
    error.$metadata = { httpStatusCode: 403 }
    throw error
  }
  try {
    await assert.rejects(sync.verifyUploadedObject(await sync.getSyncStorage(), 'key', 5n, input.hash), (error) => {
      assert.equal(error.code, 'SYNC_STORAGE_ERROR')
      assert.equal(error.details.operation, 'upload verification')
      assert.equal(error.details.storageError, 'KMS.AccessDeniedException')
      assert.equal(error.details.httpStatusCode, 403)
      return true
    })
  } finally {
    S3Client.prototype.send = previousSend
  }
})
test('commit rechecks a concurrent remote version after object verification', async () => {
  files = [{ ...row(), version: 2 }]
  uploads = [
    {
      id: 'upload',
      playerId: player.id,
      profileId: 'profile',
      path: input.path,
      hash: input.hash,
      size: 5n,
      state: 'PENDING',
      expiresAt: new Date(Date.now() + 60000),
      baseVersion: 1,
      objectKey: 'key',
      deviceId: 'device-db'
    }
  ]
  const e = await event('upload/upload/commit', 'POST', {})
  e.params.uploadId = 'upload'
  const response = await commit.POST(e)
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'SYNC_CONFLICT')
  assert.equal(files[0].version, 2)
  assert.equal(states, 0n)
})

test('garbage collection protects active files and pending uploads before deleting an orphan', async () => {
  const deleted = [],
    locks = []
  const previousSend = S3Client.prototype.send
  const previousLock = db.$executeRaw
  db.$executeRaw = async (_sql, key) => {
    locks.push(key)
    return 1
  }
  db.syncFile.count = async ({ where }) => (where.objectKey === 'players/live' ? 1 : 0)
  db.syncUpload.count = async ({ where }) => (where.objectKey === 'players/pending' ? 1 : 0)
  db.syncUpload.updateMany = async () => ({ count: 0 })
  db.syncUpload.deleteMany = async () => ({ count: 0 })
  S3Client.prototype.send = async (command) => {
    if (command.constructor.name === 'ListObjectsV2Command')
      return {
        Contents: ['players/live', 'players/pending', 'players/orphan'].map((Key) => ({ Key, LastModified: new Date(0) })),
        IsTruncated: false
      }
    if (command.constructor.name === 'DeleteObjectCommand') {
      deleted.push(command.input.Key)
      return {}
    }
    throw new Error('Unexpected storage command')
  }
  try {
    await maintenance.runSyncMaintenance()
    assert.deepEqual(deleted, ['players/orphan'])
    assert.deepEqual(locks, ['players/live', 'players/pending', 'players/orphan'])
  } finally {
    S3Client.prototype.send = previousSend
    db.$executeRaw = previousLock
  }
})
