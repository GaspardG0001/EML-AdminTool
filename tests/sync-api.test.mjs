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
let files, states, uploads, used, reserved, playerQuota, fileAggregateWhere, uploadAggregateWhere, logs, generations, leases, storedS3, metrics
const originalSend = S3Client.prototype.send
S3Client.prototype.send = async () => ({ ContentLength: 5, ChecksumSHA256: Buffer.from('a'.repeat(64), 'hex').toString('base64') })
const db = {
  profile: {
    findUnique: async () => ({ id: 'profile', slug: 'private-profile', visibility: profile.visibility }),
    findMany: async () => []
  },
  player: {
    findUnique: async ({ where }) => (where.id === player.id ? player : null),
    findMany: async () => []
  },
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
    findMany: async ({ where }) => files.filter((f) =>
      (!where.playerId || f.playerId === where.playerId) && (!where.profileId || f.profileId === where.profileId) &&
      (where.deleted === undefined || f.deleted === where.deleted) && (!where.updatedAt || f.updatedAt < where.updatedAt.lt)),
    deleteMany: async ({ where }) => {
      const removed = await db.syncFile.findMany({ where })
      files = files.filter((f) => !removed.includes(f))
      return { count: removed.length }
    },
    count: async ({ where } = {}) => files.filter((f) => !where || Object.entries(where).every(([k, v]) => f[k] === v)).length,
    upsert: async ({ where, create, update }) => {
      const file = await db.syncFile.findUnique({ where })
      if (file) { Object.assign(file, update); return file }
      const row = { id: 'new-file', updatedAt: new Date(), ...create }
      files.push(row)
      return row
    },
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
    upsert: async () => ({ revision: ++states }),
    updateMany: async () => { states++; return { count: 1 } }
  },
  syncPathVersion: {
    findUnique: async ({ where }) => generations.get(JSON.stringify(where.playerId_profileId_path)) ?? null,
    upsert: async ({ where, create }) => { generations.set(JSON.stringify(where.playerId_profileId_path), create); return create }
  },
  syncObjectLease: {
    findUnique: async ({ where }) => leases.get(where.objectKey) ?? null,
    upsert: async ({ where, create, update }) => {
      const row = leases.has(where.objectKey) ? { ...leases.get(where.objectKey), ...update } : create
      leases.set(where.objectKey, row)
      return row
    },
    deleteMany: async ({ where }) => { leases.delete(where.objectKey); return { count: 1 } },
    count: async () => [...leases.values()].filter((l) => l.expiresAt > new Date()).length
  },
  syncUpload: {
    findMany: async ({ where }) => uploads.filter((u) => u.playerId === where.playerId &&
      (!where.profileId || u.profileId === where.profileId) && u.expiresAt > where.expiresAt.gt),
    count: async () => uploads.length,
    updateMany: async () => ({ count: 1 }),
    deleteMany: async () => { uploads = []; return { count: 1 } },
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
  s3Configuration: { findUnique: async () => storedS3, upsert: async ({ create }) => { storedS3 = create; return create } },
  syncMetric: { upsert: async () => { metrics++; return {} } },
  $executeRaw: async () => 1,
  $transaction: async (callback) => callback(db)
}
globalThis.__syncTestDb = db
const vite = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
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
const singlePrepare = await vite.ssrLoadModule('/src/routes/api/sync/profiles/[profileId]/upload/prepare/+server.ts')
const jwt = await vite.ssrLoadModule('/src/lib/server/jwt.ts')
const limiter = await vite.ssrLoadModule('/src/lib/server/limiter.ts')
const profileSettings = await vite.ssrLoadModule('/src/routes/(app)/dashboard/profiles/[profileId]/sync/+page.server.ts')
const s3Credentials = await vite.ssrLoadModule('/src/lib/server/s3-configuration.ts')
const handshake = await vite.ssrLoadModule('/src/routes/api/sync/auth/handshake/+server.ts')
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
  generations = new Map()
  leases = new Map()
  storedS3 = null
  metrics = 0
  profile.visibility = 'PUBLIC'
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
  const previousFileCount = db.syncFile.count
  const previousUploadCount = db.syncUpload.count
  const previousUpdate = db.syncUpload.updateMany
  const previousDelete = db.syncUpload.deleteMany
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
    db.syncFile.count = previousFileCount
    db.syncUpload.count = previousUploadCount
    db.syncUpload.updateMany = previousUpdate
    db.syncUpload.deleteMany = previousDelete
  }
})

test('protected profiles require the profile scope on every Sync entry point', async () => {
  profile.visibility = 'PROTECTED'
  for (const [operation, method, body] of [
    ['config', 'GET'], ['revision', 'GET'], ['usage', 'GET'], ['manifest', 'GET'],
    ['download', 'POST', { path: input.path }], ['download/batch', 'POST', { paths: [input.path] }],
    ['uploads/prepare', 'POST', { files: [{ ...input, size: '5' }] }], ['file', 'DELETE', { ...input, size: '5' }]
  ]) assert.equal((await route[method](await event(operation, method, body))).status, 401, operation)
  const e = await event('upload/prepare', 'POST', { ...input, size: '5' })
  assert.equal((await singlePrepare.POST(e)).status, 401)
  e.params.uploadId = 'upload'
  assert.equal((await commit.POST(e)).status, 401)
  e.request.headers.set('X-Profile-Token', await jwt.createScopedToken('profile', '2h', { slug: 'wrong' }))
  assert.equal((await route.GET(await withHeader(await event('config'), e.request.headers.get('X-Profile-Token')))).status, 401)
  const token = await jwt.createScopedToken('profile', '2h', { slug: 'private-profile' })
  assert.equal((await route.GET(await withHeader(await event('config'), token))).status, 200)
  e.request.headers.set('X-Profile-Token', token)
  assert.equal((await singlePrepare.POST(e)).status, 200)
  const expired = await jwt.createScopedToken('profile', '-1s', { slug: 'private-profile' })
  assert.equal((await route.GET(await withHeader(await event('config'), expired))).status, 401)
})

async function withHeader(e, token) { e.request.headers.set('X-Profile-Token', token); return e }

test('over-quota players can replace a file to return under quota', async () => {
  playerQuota = 90n
  used = 100n
  files = [{ ...row(), size: 20n }]
  await prepare.prepareSyncUpload(player.id, 'profile', { ...input, baseVersion: 1 })
  assert.equal(uploads[0].reservedBytes, 0n)
  reserved = 6n
  await assert.rejects(prepare.prepareSyncUpload(player.id, 'profile', { ...input, baseVersion: 1 }), { code: 'QUOTA_EXCEEDED' })
})

test('device casing is normalized for preparation and deletion', async () => {
  const parsed = sync.parseUploadRequest({ ...input, size: '5', deviceId: 'DEVICE-A' })
  assert.equal(parsed.deviceId, 'device-a')
  await prepare.prepareSyncUpload(player.id, 'profile', { ...input, deviceId: 'DEVICE-A' })
  files = [row()]
  assert.equal((await api.deleteSyncFile(player.id, 'profile', { ...input, baseVersion: 1, deviceId: 'DEVICE-A' })).success, true)
})

test('upload batches preserve successes alongside validation and serialization failures', async () => {
  const original = db.syncUpload.create
  let call = 0
  db.syncUpload.create = async (args) => {
    if (++call === 2) {
      const { Prisma } = await import('@prisma/client')
      throw new Prisma.PrismaClientKnownRequestError('Conflict', { code: 'P2034', clientVersion: 'test' })
    }
    return original(args)
  }
  try {
    const response = await route.POST(await event('uploads/prepare', 'POST', {
      deviceId: 'device-a', files: [
        { ...input, size: '5' }, { ...input, size: '5', path: 'saves/second' },
        { ...input, size: 'invalid', path: 'saves/third' }, null
      ]
    }))
    assert.equal(response.status, 200)
    const result = (await response.json()).files
    assert.equal(result[0].uploadId, 'upload')
    assert.equal(result[1].error, 'VERSION_CONFLICT')
    assert.equal(result[2].error, 'INVALID_SIZE')
    assert.equal(result[3].error, 'INVALID_REQUEST')
    assert.equal(uploads.length, 1)
  } finally { db.syncUpload.create = original }
})

test('unauthorized and throttled requests do not write counters', async () => {
  sync.syncErrorResponse(new sync.SyncApiError('Unauthorized', 'UNAUTHORIZED', 401))
  sync.syncErrorResponse(new sync.SyncApiError('Throttled', 'TOO_MANY_REQUESTS', 429))
  assert.equal(metrics, 0)
})

test('renewal permits short token lifetimes and players sharing an IP', () => {
  const start = Date.now()
  for (let minute = 0; minute < 60; minute++) {
    for (let p = 0; p < 16; p++) {
      assert.equal(limiter.syncHandshakeLimiter.canPerformAction('shared-ip', start + minute * 60000), true)
      assert.equal(limiter.canRenewSyncPlayer(`renew-${p}`, 60, start + minute * 60000), true)
    }
  }
  for (let attempt = 0; attempt < 10; attempt++) assert.equal(limiter.canRenewSyncPlayer('abuser', 60, start), true)
  assert.equal(limiter.canRenewSyncPlayer('abuser', 60, start), false)
})

test('configuration data is hidden from viewers and unreadable credentials allow recovery', async () => {
  storedS3 = { region: 'test', bucket: 'bucket', endpoint: 'https://example.test', accessKeyIdEncrypted: 'broken', secretAccessKeyEncrypted: 'broken' }
  const loadEvent = (p_sync) => ({ locals: { user: { id: 'staff', p_sync } }, url: new URL('http://localhost/dashboard/sync') })
  assert.equal((await dashboard.load(loadEvent(2))).configuration, null)
  const config = (await dashboard.load(loadEvent(1))).configuration
  assert.equal(config.accessKeyId, '')
  assert.equal(config.credentialsConfigured, false)
  assert.equal(config.credentialsUnreadable, true)
})

test('administrative reset preserves generations and recreated files reject stale writes', async () => {
  files = [row()]
  await maintenance.deletePlayerSyncData('admin', player.id, 'profile')
  assert.equal(files.length, 0)
  assert.equal([...generations.values()][0].version, 1)
  uploads = [{ id: 'upload', playerId: player.id, profileId: 'profile', path: input.path, hash: input.hash,
    size: 5n, state: 'PENDING', expiresAt: new Date(Date.now() + 60000), baseVersion: null, objectKey: 'key', deviceId: 'device-db' }]
  const e = await event('upload/upload/commit', 'POST', {})
  e.params.uploadId = 'upload'
  const response = await commit.POST(e)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).file.version, 2)
  await assert.rejects(api.deleteSyncFile(player.id, 'profile', { ...input, baseVersion: 1 }), { code: 'VERSION_CONFLICT' })
  await assert.rejects(prepare.prepareSyncUpload(player.id, 'profile', { ...input, baseVersion: 1 }), { code: 'VERSION_CONFLICT' })
})

test('tombstone collection retains the last path version', async () => {
  files = [{ ...row(), deleted: true, version: 7, updatedAt: new Date(0) }]
  const previous = S3Client.prototype.send
  S3Client.prototype.send = async () => ({ Contents: [], IsTruncated: false })
  try {
    await maintenance.runSyncMaintenance()
    assert.equal(files.length, 0)
    assert.equal([...generations.values()][0].version, 7)
    assert.equal(states, 1n)
  } finally { S3Client.prototype.send = previous }
})

test('a fresh download lease protects an old object after the file is deleted', async () => {
  files = [row()]
  const download = await api.prepareDownload(player.id, 'profile', { path: input.path })
  assert.ok(download.downloadUrl)
  assert.ok(leases.get('key').expiresAt > new Date())
  files = []
  const previous = S3Client.prototype.send
  const deleted = []
  S3Client.prototype.send = async (command) => {
    if (command.constructor.name === 'ListObjectsV2Command')
      return { Contents: [{ Key: 'key', LastModified: new Date(0) }], IsTruncated: false }
    if (command.constructor.name === 'DeleteObjectCommand') { deleted.push(command.input.Key); return {} }
    throw new Error('Unexpected command')
  }
  try {
    await maintenance.runSyncMaintenance()
    assert.deepEqual(deleted, [])
    leases.get('key').expiresAt = new Date(0)
    await maintenance.runSyncMaintenance()
    assert.deepEqual(deleted, ['key'])
  } finally { S3Client.prototype.send = previous }
})

test('an invalid listing cursor is cleared before the next maintenance retry', async () => {
  const previous = S3Client.prototype.send
  const cursors = []
  S3Client.prototype.send = async (command) => {
    cursors.push(command.input.ContinuationToken)
    if (cursors.length === 1) return { Contents: [], IsTruncated: true, NextContinuationToken: 'expired-cursor' }
    if (cursors.length === 2) { const error = new Error('private SDK details'); error.name = 'InvalidToken'; throw error }
    return { Contents: [], IsTruncated: false }
  }
  try {
    await maintenance.runSyncMaintenance()
    await maintenance.runSyncMaintenance()
    await maintenance.runSyncMaintenance()
    assert.deepEqual(cursors, [undefined, 'expired-cursor', undefined])
  } finally { S3Client.prototype.send = previous }
})

test('rule changes advance revisions and database failures return 500', async () => {
  const oldUpsert = db.syncProfile.upsert
  const oldRule = db.syncRule
  const oldTransaction = db.$transaction
  db.syncProfile.upsert = async () => ({ id: 'sync-profile' })
  db.syncRule = { deleteMany: async () => ({}), createMany: async () => ({}) }
  const e = () => ({
    locals: { user: { id: 'admin', p_sync: 1 } }, params: { profileId: 'profile' },
    request: new Request('http://localhost', { method: 'POST', body: new URLSearchParams({ path: 'saves/**', action: 'INCLUDE', 'enabled-0': 'on', enabled: 'on', maxFileBytes: '' }) })
  })
  try {
    assert.deepEqual(await profileSettings.actions.default(e()), { success: true })
    assert.equal(states, 1n)
    const stale = await route.GET(await event('manifest?revision=0'))
    assert.equal(stale.status, 409)
    db.$transaction = async () => { throw new Error('database unavailable') }
    assert.equal((await profileSettings.actions.default(e())).status, 500)
  } finally { db.syncProfile.upsert = oldUpsert; db.syncRule = oldRule; db.$transaction = oldTransaction }
})

test('storage location changes are blocked while metadata depends on it', async () => {
  process.env.S3_ENCRYPTION_KEY = 'a'.repeat(64)
  storedS3 = { id: '1', region: 'test', bucket: 'original', endpoint: 'https://example.test',
    accessKeyIdEncrypted: s3Credentials.encryptS3Credential('access'), secretAccessKeyEncrypted: s3Credentials.encryptS3Credential('secret'), updatedAt: new Date() }
  files = [row()]
  const e = (bucket) => ({ locals: { user: { id: 'admin', isAdmin: true } },
    request: new Request('http://localhost', { method: 'POST', body: new URLSearchParams({ region: 'test', bucket, endpoint: 'https://example.test', accessKeyId: '', secretAccessKey: '' }) }) })
  try {
    assert.equal((await dashboard.actions.save(e('different'))).status, 409)
    assert.equal(storedS3.bucket, 'original')
    assert.equal((await dashboard.actions.save(e('original'))).success, true)
  } finally { delete process.env.S3_ENCRYPTION_KEY }
})

test('malformed unauthenticated handshakes do not write metrics', async () => {
  const e = { getClientAddress: () => 'bad-handshake-ip', request: new Request('http://localhost', { method: 'POST', body: '{' }) }
  assert.equal((await handshake.POST(e)).status, 400)
  assert.equal(metrics, 0)
})

test('reset retains outstanding PUT protection after upload sessions are removed', async () => {
  const expiresAt = new Date(Date.now() + 60000)
  uploads = [{ playerId: player.id, profileId: 'profile', objectKey: 'late-put', expiresAt, state: 'PENDING' }]
  await maintenance.deletePlayerSyncData('admin', player.id, 'profile')
  assert.equal(uploads.length, 0)
  assert.equal(leases.get('late-put').expiresAt, expiresAt)
})

test('storage configuration reads use the supplied transaction client', async () => {
  let reads = 0
  await sync.getSyncStorage({ s3Configuration: { findUnique: async () => { reads++; return null } } })
  assert.equal(reads, 1)
})

test('signed PUT validity cannot outlast its upload session', async () => {
  const storage = await sync.getSyncStorage()
  const expiresAt = new Date(Date.now() + 12345)
  const url = new URL(await sync.signUploadUrl(storage, 'key', input.hash, input.size, expiresAt))
  const date = url.searchParams.get('X-Amz-Date')
  const signedAt = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`)
  const deadline = signedAt.getTime() + Number(url.searchParams.get('X-Amz-Expires')) * 1000
  assert.ok(deadline <= expiresAt.getTime())
  assert.ok(deadline > Date.now())
  await assert.rejects(sync.signUploadUrl(storage, 'key', input.hash, input.size, new Date(0)), { code: 'UPLOAD_EXPIRED' })
})
