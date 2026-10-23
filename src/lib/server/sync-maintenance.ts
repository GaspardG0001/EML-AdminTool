import { db } from './db'
import { deleteSyncObject, listSyncObjects, getSyncRuntimeConfig, getSyncStorage } from './sync'
import { recordSyncMetric } from './sync-metrics'
import type { Prisma } from '@prisma/client'

// The same per-object lock is used by upload preparation/commit and collection.
export async function lockSyncObject(tx: Prisma.TransactionClient, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
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
        const removed = await tx.syncFile.deleteMany({
          where: { ...state, deleted: true, updatedAt: { lt: new Date(now.getTime() - retention * 86400000) } }
        })
        if (removed.count) await tx.playerSyncState.updateMany({ where: state, data: { revision: { increment: 1n } } })
      })
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
          const [files, uploads] = await Promise.all([
            tx.syncFile.count({ where: { objectKey: key, deleted: false } }),
            tx.syncUpload.count({ where: { objectKey: key, state: 'PENDING', expiresAt: { gt: new Date() } } })
          ])
          if (!files && !uploads) {
            await deleteSyncObject(storage, key)
          }
        },
        { timeout: 30000 }
      )
    }
    continuationToken = page.nextCursor
    await db.syncUpload.deleteMany({ where: { state: { not: 'PENDING' }, expiresAt: { lt: new Date(now.getTime() - retention * 86400000) } } })
  } catch {
    await recordSyncMetric('storage_failures')
    console.error('Sync maintenance failed; it will retry on the next interval')
  } finally {
    collecting = false
  }
}

export async function deletePlayerSyncData(adminId: string, playerId: string, profileId?: string) {
  await db.$transaction(
    async (tx) => {
      const where = { playerId, ...(profileId ? { profileId } : {}) }
      // Invalidate signed upload sessions before releasing file references.
      await tx.syncUpload.deleteMany({ where })
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
