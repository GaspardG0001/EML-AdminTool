import { db } from './db'
import { deleteSyncObject, listSyncObjects, getSyncRuntimeConfig, getSyncStorage } from './sync'
import { recordSyncMetric } from './sync-metrics'
import type { Prisma } from '@prisma/client'

// The same per-object lock is used by upload preparation/commit and collection.
export async function lockSyncObject(tx: Prisma.TransactionClient, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

export async function lockSyncStorage(tx: Prisma.TransactionClient, shared = false) {
  if (shared) await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('sync-storage-configuration', 0))`
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('sync-storage-configuration', 0))`
}

async function preservePathVersions(tx: Prisma.TransactionClient, where: Prisma.SyncFileWhereInput) {
  const files = await tx.syncFile.findMany({ where, select: { playerId: true, profileId: true, path: true, version: true } })
  for (const file of files)
    await tx.syncPathVersion.upsert({
      where: { playerId_profileId_path: { playerId: file.playerId, profileId: file.profileId, path: file.path } },
      create: file,
      update: { version: file.version }
    })
}

let collecting = false
let continuationToken: string | undefined

export async function runSyncMaintenance() {
  if (collecting || process.env.SYNC_ENABLED !== 'true') return
  collecting = true
  try {
    const now = new Date()
    await db.syncUpload.updateMany({ where: { state: 'PENDING', expiresAt: { lte: now } }, data: { state: 'EXPIRED' } })
    // Clients treat a missing remote base as a conflict after retention expires.
    const retention = Number(process.env.SYNC_TOMBSTONE_RETENTION_DAYS ?? 90)
    if (!Number.isInteger(retention) || retention < 1) throw new Error('Invalid tombstone retention')
    // Purge metadata only with a revision bump, so cached manifests are invalidated.
    const states = await db.syncFile.findMany({
      where: { deleted: true, updatedAt: { lt: new Date(now.getTime() - retention * 86400000) } },
      select: { playerId: true, profileId: true },
      distinct: ['playerId', 'profileId'],
      take: 100
    })
    for (const state of states)
      await db.$transaction(async (tx) => {
        await preservePathVersions(tx, { ...state, deleted: true, updatedAt: { lt: new Date(now.getTime() - retention * 86400000) } })
        const removed = await tx.syncFile.deleteMany({
          where: { ...state, deleted: true, updatedAt: { lt: new Date(now.getTime() - retention * 86400000) } }
        })
        if (removed.count) await tx.playerSyncState.updateMany({ where: state, data: { revision: { increment: 1n } } })
      }, { isolationLevel: 'Serializable' })
    const storage = await getSyncStorage()
    const page = await listSyncObjects(storage, continuationToken)
    // Leave enough time for signed PUTs to expire, including a second late PUT.
    const cutoff = now.getTime() - Math.max(getSyncRuntimeConfig().signedUrlTtl * 2000, 3600000)
    for (const object of page.objects) {
      if (!object.key || !object.lastModified || object.lastModified.getTime() >= cutoff) continue
      const key = object.key
      await db.$transaction(
        async (tx) => {
          await lockSyncObject(tx, key)
          const [files, uploads, lease] = await Promise.all([
            tx.syncFile.count({ where: { objectKey: key, deleted: false } }),
            tx.syncUpload.count({ where: { objectKey: key, state: 'PENDING', expiresAt: { gt: new Date() } } }),
            tx.syncObjectLease.findUnique({ where: { objectKey: key } })
          ])
          if (!files && !uploads && (!lease || lease.expiresAt <= new Date())) {
            await deleteSyncObject(storage, key)
            await tx.syncObjectLease.deleteMany({ where: { objectKey: key } })
          }
        },
        { timeout: 30000 }
      )
    }
    continuationToken = page.nextCursor
    await db.syncUpload.deleteMany({ where: { state: { not: 'PENDING' }, expiresAt: { lt: new Date(now.getTime() - retention * 86400000) } } })
  } catch (err) {
    continuationToken = undefined
    await recordSyncMetric('storage_failures')
    const name = err instanceof Error && /^[\w.-]{1,64}$/.test(err.name) ? err.name : 'UnknownError'
    console.error('Sync maintenance failed; it will retry on the next interval', name)
  } finally {
    collecting = false
  }
}

export async function deletePlayerSyncData(adminId: string, playerId: string, profileId?: string) {
  await db.$transaction(
    async (tx) => {
      await lockSyncStorage(tx, true)
      const where = { playerId, ...(profileId ? { profileId } : {}) }
      // Removing a session cannot revoke an already signed PUT. Keep its deadline
      // independently, including when deleting devices cascades to their sessions.
      const uploads = await tx.syncUpload.findMany({
        where: { ...where, expiresAt: { gt: new Date() } },
        select: { objectKey: true, expiresAt: true },
        orderBy: { objectKey: 'asc' }
      })
      for (const upload of uploads) {
        await lockSyncObject(tx, upload.objectKey)
        const lease = await tx.syncObjectLease.findUnique({ where: { objectKey: upload.objectKey } })
        await tx.syncObjectLease.upsert({
          where: { objectKey: upload.objectKey },
          create: upload,
          update: { expiresAt: lease && lease.expiresAt > upload.expiresAt ? lease.expiresAt : upload.expiresAt }
        })
      }
      // Invalidate signed upload sessions before releasing file references.
      await tx.syncUpload.deleteMany({ where })
      await preservePathVersions(tx, where)
      await tx.syncFile.deleteMany({ where })
      // Keep a monotonic revision, including across an administrative reset.
      await tx.playerSyncState.updateMany({ where, data: { revision: { increment: 1n } } })
      if (!profileId) await tx.playerDevice.deleteMany({ where: { playerId } })
      await tx.log.create({
        data: { userId: adminId, action: 'sync.player.data.deleted', details: JSON.stringify({ playerId, profileId: profileId ?? null }) }
      })
    },
    { isolationLevel: 'Serializable' }
  )
}
