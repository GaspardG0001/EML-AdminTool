import { recordSyncMetric } from './sync-metrics'
import { Prisma } from '@prisma/client'
import { db } from './db'
import { lockSyncObject, lockSyncStorage } from './sync-maintenance'
import {
  signDownloadUrl,
  getSyncProfile,
  getSyncPlayerQuota,
  getSyncRuntimeConfig,
  getSyncStorage,
  verifyUploadedObject,
  isSyncPathAllowed,
  normalizeSyncPath,
  SyncApiError
} from './sync'

export function objectBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SyncApiError('Expected an object', 'INVALID_REQUEST', 400)
  return input as Record<string, unknown>
}

export function checkVersion(actual: number | null, expected: unknown): void {
  if (expected !== null && (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1)) {
    throw new SyncApiError('Invalid base version', 'INVALID_VERSION', 400)
  }
  if (actual !== expected)
    throw new SyncApiError('File version has changed', 'VERSION_CONFLICT', 409, { expectedVersion: expected, currentVersion: actual })
}

export async function assertSyncWritable(): Promise<void> {
  const maintenance = await db.maintenance.findUnique({ where: { id: '1' } })
  const now = new Date()
  if (maintenance?.startTime && maintenance.startTime <= now && (!maintenance.endTime || maintenance.endTime > now)) {
    throw new SyncApiError('Synchronization writes are paused during maintenance', 'SYNC_MAINTENANCE', 503)
  }
}

export async function getPlayerDevice(playerId: string, deviceUuid: unknown) {
  if (typeof deviceUuid !== 'string') throw new SyncApiError('Invalid device', 'INVALID_DEVICE', 400)
  const device = await db.playerDevice.findUnique({ where: { playerId_deviceUuid: { playerId, deviceUuid: deviceUuid.toLowerCase() } } })
  if (!device) throw new SyncApiError('Device does not belong to player', 'DEVICE_NOT_FOUND', 403)
  return device
}

export async function syncConfiguration(profileId: string) {
  if (!(await db.profile.findUnique({ where: { id: profileId }, select: { id: true } }))) {
    throw new SyncApiError('Profile not found', 'SYNC_PROFILE_NOT_FOUND', 404)
  }
  const profile = await db.syncProfile.findUnique({ where: { profileId }, include: { rules: { orderBy: { id: 'asc' } } } })
  const config = getSyncRuntimeConfig()
  const quota = await getSyncPlayerQuota()
  return {
    enabled: profile?.enabled ?? false,
    limits: {
      maxStorageBytes: quota.toString(),
      maxFileBytes: (profile?.maxFileBytes ?? config.defaultMaxFileSize).toString()
    },
    rules: profile?.rules.filter((r) => r.enabled).map(({ path, action }) => ({ path, action })) ?? []
  }
}

export async function syncRevision(playerId: string, profileId: string) {
  const state = await db.playerSyncState.findUnique({ where: { playerId_profileId: { playerId, profileId } } })
  return { revision: (state?.revision ?? 0n).toString() }
}

export async function syncUsage(playerId: string, profileId: string) {
  return db.$transaction(
    async (tx) => {
      const profile = await tx.syncProfile.findUnique({ where: { profileId }, select: { enabled: true } })
      if (!profile) throw new SyncApiError('Sync is not configured for this profile', 'SYNC_PROFILE_NOT_FOUND', 404)
      if (!profile.enabled) throw new SyncApiError('Sync is disabled for this profile', 'SYNC_DISABLED', 403)

      const where = { playerId }
      const [quota, files, uploads] = await Promise.all([
        getSyncPlayerQuota(tx),
        tx.syncFile.groupBy({ by: ['profileId'], where: { ...where, deleted: false }, _sum: { size: true } }),
        tx.syncUpload.groupBy({
          by: ['profileId'],
          where: { ...where, state: 'PENDING', expiresAt: { gt: new Date() } },
          _sum: { reservedBytes: true }
        })
      ])
      const profiles = new Map<string, { usedBytes: bigint; reservedBytes: bigint }>()
      for (const file of files) profiles.set(file.profileId, { usedBytes: file._sum.size ?? 0n, reservedBytes: 0n })
      for (const upload of uploads) {
        const usage = profiles.get(upload.profileId) ?? { usedBytes: 0n, reservedBytes: 0n }
        usage.reservedBytes = upload._sum.reservedBytes ?? 0n
        profiles.set(upload.profileId, usage)
      }
      let usedBytes = 0n
      let reservedBytes = 0n
      const breakdown = Array.from(profiles, ([id, usage]) => {
        usedBytes += usage.usedBytes
        reservedBytes += usage.reservedBytes
        return { profileId: id, usedBytes: usage.usedBytes.toString(), reservedBytes: usage.reservedBytes.toString() }
      }).sort((a, b) => a.profileId.localeCompare(b.profileId))
      return {
        scope: 'player',
        quotaBytes: quota.toString(),
        usedBytes: usedBytes.toString(),
        reservedBytes: reservedBytes.toString(),
        profiles: breakdown
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  )
}

export async function syncManifest(playerId: string, profileId: string, url: URL) {
  const limit = Number(url.searchParams.get('limit') ?? 1000)
  const cursor = url.searchParams.get('cursor')
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000 || (cursor && cursor.length > 128))
    throw new SyncApiError('Invalid pagination', 'INVALID_REQUEST', 400)
  // Each page and its revision come from the same database snapshot.
  return db.$transaction(
    async (tx) => {
      const profile = await getSyncProfile(profileId, tx)
      const state = await tx.playerSyncState.findUnique({ where: { playerId_profileId: { playerId, profileId } } })
      const revision = (state?.revision ?? 0n).toString()
      if (url.searchParams.has('revision') && url.searchParams.get('revision') !== revision)
        throw new SyncApiError('Manifest changed; restart pagination', 'MANIFEST_CHANGED', 409)
      const rows = await tx.syncFile.findMany({
        where: { playerId, profileId, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: limit + 1
      })
      const page = rows.slice(0, limit)
      return {
        revision,
        files: Object.fromEntries(
          page
            .filter((file) => isSyncPathAllowed(file.path, profile.rules))
            .map((file) => [
              file.path,
              { hash: file.hash, size: file.size.toString(), version: file.version, deleted: file.deleted, updatedAt: file.updatedAt.toISOString() }
            ])
        ),
        nextCursor: rows.length > limit ? page.at(-1)!.id : null
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  )
}

export async function prepareDownload(playerId: string, profileId: string, input: unknown) {
  const path = normalizeSyncPath(objectBody(input).path)
  const profile = await getSyncProfile(profileId)
  if (!isSyncPathAllowed(path, profile.rules)) throw new SyncApiError('Path is not allowed', 'PATH_NOT_ALLOWED', 403)
  const result = await db.$transaction(async (tx) => {
    await lockSyncStorage(tx, true)
    const storage = await getSyncStorage(tx)
    const file = await tx.syncFile.findUnique({ where: { playerId_profileId_path: { playerId, profileId, path } } })
    if (!file || file.deleted || !file.objectKey) throw new SyncApiError('File not found', 'SYNC_FILE_NOT_FOUND', 404)
    await lockSyncObject(tx, file.objectKey)
    // Recheck after locking: collection may have won the race before this request.
    await verifyUploadedObject(storage, file.objectKey, file.size, file.hash!)
    const downloadUrl = await signDownloadUrl(storage, file.objectKey)
    const expiresAt = new Date(Date.now() + storage.signedUrlTtl * 1000)
    const lease = await tx.syncObjectLease.findUnique({ where: { objectKey: file.objectKey } })
    await tx.syncObjectLease.upsert({
      where: { objectKey: file.objectKey },
      create: { objectKey: file.objectKey, expiresAt },
      update: { expiresAt: lease && lease.expiresAt > expiresAt ? lease.expiresAt : expiresAt }
    })
    return { path, hash: file.hash, size: file.size.toString(), version: file.version, downloadUrl }
  }, { timeout: 30000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  await recordSyncMetric('downloads_prepared')
  return result
}

export async function deleteSyncFile(playerId: string, profileId: string, input: unknown) {
  await assertSyncWritable()
  const body = objectBody(input)
  const path = normalizeSyncPath(body.path)
  const profile = await getSyncProfile(profileId)
  if (!isSyncPathAllowed(path, profile.rules)) throw new SyncApiError('Path is not allowed', 'PATH_NOT_ALLOWED', 403)
  const device = await getPlayerDevice(playerId, body.deviceId)
  return db.$transaction(
    async (tx) => {
      const file = await tx.syncFile.findUnique({ where: { playerId_profileId_path: { playerId, profileId, path } } })
      checkVersion(file?.version ?? null, body.baseVersion)
      if (!file) throw new SyncApiError('File not found', 'SYNC_FILE_NOT_FOUND', 404)
      if (file.deleted) return { success: true, file: { path, version: file.version, deleted: true }, ...(await syncRevision(playerId, profileId)) }
      if (file.version >= 2147483647) throw new SyncApiError('Version limit reached', 'VERSION_LIMIT_REACHED', 409)
      const updated = await tx.syncFile.update({
        where: { id: file.id },
        data: { deleted: true, hash: null, size: 0n, objectKey: null, deviceId: device.id, version: { increment: 1 } }
      })
      const state = await tx.playerSyncState.upsert({
        where: { playerId_profileId: { playerId, profileId } },
        create: { playerId, profileId, revision: 1n },
        update: { revision: { increment: 1n } }
      })
      return { success: true, file: { path, version: updated.version, deleted: true }, revision: state.revision.toString() }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  )
}
