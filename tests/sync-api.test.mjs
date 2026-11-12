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
let files, states, uploads, used, reserved, playerQuota, fileAggregateWhere, uploadAggregateWhere, logs
const originalSend = S3Client.prototype.send
S3Client.prototype.send = async () => ({ ContentLength: 5, ChecksumSHA256: Buffer.from('a'.repeat(64), 'hex').toString('base64') })
const db = {
  player: { findUnique: async ({ where }) => (where.id === player.id ? player : null) },
  profile: { findUnique: async () => ({ id: 'profile' }) },
  syncProfile: { findUnique: async ({ where }) => (where.profileId === profile.profileId ? profile : null) },
  syncConfiguration: {
    findUnique: async () => playerQuota === null ? null : { playerQuotaBytes: playerQuota },
    upsert: async ({ create }) => { playerQuota = create.playerQuotaBytes }
  },
  log: { create: async ({ data }) => { logs.push(data) } },
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
    aggregate: async ({ where }) => {
      fileAggregateWhere = where
      return { _sum: { size: used } }
    },
    groupBy: async ({ where }) => {
      const groups = new Map()
      for (const file of files) {
        if (file.playerId !== where.playerId || (where.profileId && file.profileId !== where.profileId) || file.deleted !== where.deleted) continue
        groups.set(file.profileId, (groups.get(file.profileId) ?? 0n) + file.size)
      }
      return [...groups].map(([profileId, size]) => ({ profileId, _sum: { size } }))
    },
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
    aggregate: async ({ where }) => {
      uploadAggregateWhere = where
      return { _sum: { reservedBytes: reserved } }
    },
    groupBy: async ({ where }) => {
      const groups = new Map()
      for (const upload of uploads) {
        if (
          upload.playerId !== where.playerId ||
          (where.profileId && upload.profileId !== where.profileId) ||
          upload.state !== where.state ||
          upload.expiresAt <= where.expiresAt.gt
        ) continue
        groups.set(upload.profileId, (groups.get(upload.profileId) ?? 0n) + upload.reservedBytes)
      }
      return [...groups].map(([profileId, reservedBytes]) => ({ profileId, _sum: { reservedBytes } }))
    },
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
const dashboard = await vite.ssrLoadModule('/src/routes/(app)/dashboard/sync/+page.server.ts')
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
  playerQuota = null
  fileAggregateWhere = null
  uploadAggregateWhere = null
  logs = []
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
test('usage reports player-scoped logical storage and live reservations by profile', async () => {
  const previousQuota = process.env.SYNC_DEFAULT_PLAYER_QUOTA
  process.env.SYNC_DEFAULT_PLAYER_QUOTA = '90071992547409930'
  try {
    files = [
      row(),
      { ...row(), id: 'hidden', profileId: 'other', path: 'hidden/file', size: 12n },
      { ...row(), id: 'deleted', size: 50n, deleted: true },
      { ...row(), id: 'another-player', playerId: 'player-b', size: 100n }
    ]
    const future = new Date(Date.now() + 60000)
    const past = new Date(Date.now() - 60000)
    uploads = [
      { playerId: player.id, profileId: 'other', state: 'PENDING', expiresAt: future, reservedBytes: 3n },
      { playerId: player.id, profileId: 'pending-only', state: 'PENDING', expiresAt: future, reservedBytes: 4n },
      { playerId: player.id, profileId: 'profile', state: 'PENDING', expiresAt: past, reservedBytes: 100n },
      { playerId: player.id, profileId: 'profile', state: 'COMMITTED', expiresAt: future, reservedBytes: 100n },
      { playerId: 'player-b', profileId: 'profile', state: 'PENDING', expiresAt: future, reservedBytes: 100n }
    ]
    assert.equal((await route.GET(await event('usage', 'GET', undefined, false))).status, 401)
    const response = await route.GET(await event('usage'))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      scope: 'player',
      quotaBytes: '90071992547409930',
      usedBytes: '17',
      reservedBytes: '7',
      profiles: [
        { profileId: 'other', usedBytes: '12', reservedBytes: '3' },
        { profileId: 'pending-only', usedBytes: '0', reservedBytes: '4' },
        { profileId: 'profile', usedBytes: '5', reservedBytes: '0' }
      ]
    })
  } finally {
    if (previousQuota === undefined) delete process.env.SYNC_DEFAULT_PLAYER_QUOTA
    else process.env.SYNC_DEFAULT_PLAYER_QUOTA = previousQuota
  }
})
test('usage ignores legacy profile quotas and handles empty or disabled profiles', async () => {
  profile.maxStorageBytes = 10n
  playerQuota = 200n
  files = [row(), { ...row(), profileId: 'other', size: 100n }]
  uploads = [{ playerId: player.id, profileId: 'profile', state: 'PENDING', expiresAt: new Date(Date.now() + 60000), reservedBytes: 2n }]
  assert.deepEqual(await (await route.GET(await event('usage'))).json(), {
    scope: 'player',
    quotaBytes: '200',
    usedBytes: '105',
    reservedBytes: '2',
    profiles: [
      { profileId: 'other', usedBytes: '100', reservedBytes: '0' },
      { profileId: 'profile', usedBytes: '5', reservedBytes: '2' }
    ]
  })
  assert.equal((await (await route.GET(await event('config'))).json()).limits.maxStorageBytes, '200')
  files = []
  uploads = []
  assert.deepEqual(await (await route.GET(await event('usage'))).json(), {
    scope: 'player', quotaBytes: '200', usedBytes: '0', reservedBytes: '0', profiles: []
  })
  profile.enabled = false
  assert.equal((await route.GET(await event('usage'))).status, 403)
  const missing = await event('usage')
  missing.params.profileId = 'missing'
  assert.equal((await route.GET(missing)).status, 404)
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
  profile.maxStorageBytes = 1000n
  playerQuota = 10n
  used = 7n
  reserved = 2n
  await assert.rejects(prepare.prepareSyncUpload(player.id, 'profile', input), { code: 'QUOTA_EXCEEDED' })
  assert.deepEqual(fileAggregateWhere, { playerId: player.id, deleted: false })
  assert.equal(uploadAggregateWhere.playerId, player.id)
  assert.equal('profileId' in uploadAggregateWhere, false)
  assert.equal(uploads.length, 0)
  files = [row()]
  used = 5n
  reserved = 0n
  const result = await prepare.prepareSyncUpload(player.id, 'profile', { ...input, baseVersion: 1 })
  assert.equal(result.uploadRequired, false)
  assert.equal(uploads[0].reservedBytes, 0n)
  assert.equal(uploads[0].playerId, player.id)
})
test('commit rechecks the shared quota across profiles', async () => {
  profile.maxStorageBytes = 1000n
  playerQuota = 10n
  used = 7n
  uploads = [{
    id: 'upload', playerId: player.id, profileId: 'profile', path: input.path, hash: input.hash,
    size: 5n, state: 'PENDING', expiresAt: new Date(Date.now() + 60000),
    baseVersion: null, objectKey: 'key', deviceId: 'device-db'
  }]
  const e = await event('upload/upload/commit', 'POST', {})
  e.params.uploadId = 'upload'
  const response = await commit.POST(e)
  assert.equal(response.status, 413)
  assert.equal((await response.json()).code, 'QUOTA_EXCEEDED')
  assert.deepEqual(fileAggregateWhere, { playerId: player.id, deleted: false })
  assert.equal('profileId' in uploadAggregateWhere, false)
  assert.equal(states, 0n)
})
test('dashboard quota requires permission, validates input and takes precedence over the environment', async () => {
  const formEvent = (value, user) => ({
    locals: { user },
    request: new Request('http://localhost/dashboard/sync?/saveQuota', {
      method: 'POST', body: new URLSearchParams({ playerQuotaBytes: value })
    })
  })
  const editor = { id: 'admin', isAdmin: false, p_sync: 1 }
  assert.equal((await dashboard.actions.saveQuota(formEvent('42', { p_sync: 2 }))).status, 403)
  assert.equal((await dashboard.actions.saveQuota(formEvent('9223372036854775808', editor))).status, 400)
  assert.equal((await dashboard.actions.saveQuota(formEvent('-1', editor))).status, 400)
  assert.equal(playerQuota, null)
  assert.deepEqual(await dashboard.actions.saveQuota(formEvent('42', editor)), { quotaSaved: true })
  assert.equal(await sync.getSyncPlayerQuota(), 42n)
  assert.equal(logs[0].action, 'sync.quota.modified')
  assert.equal(logs[0].details, '{"playerQuotaBytes":"42"}')
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
