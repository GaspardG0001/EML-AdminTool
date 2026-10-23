import { db } from './db'

export async function recordSyncMetric(name: string, count = 1n): Promise<void> {
  try {
    await db.syncMetric.upsert({ where: { name }, create: { name, count }, update: { count: { increment: count } } })
  } catch {
    console.warn('Could not record sync metric', name)
  }
}

export async function getSyncStatistics() {
  const [players, devices, files, pending, logical, objects, metrics, profiles, names] = await Promise.all([
    db.player.count(),
    db.playerDevice.count(),
    db.syncFile.count({ where: { deleted: false } }),
    db.syncUpload.count({ where: { state: 'PENDING', expiresAt: { gt: new Date() } } }),
    db.syncFile.aggregate({ where: { deleted: false }, _sum: { size: true } }),
    db.syncFile.groupBy({ by: ['objectKey'], where: { deleted: false, objectKey: { not: null } }, _max: { size: true } }),
    db.syncMetric.findMany(),
    db.syncFile.groupBy({ by: ['profileId'], where: { deleted: false }, _count: true, _sum: { size: true } }),
    db.profile.findMany({ select: { id: true, name: true } })
  ])
  return {
    players,
    devices,
    files,
    pending,
    logicalBytes: (logical._sum.size ?? 0n).toString(),
    referencedPhysicalBytes: objects.reduce((sum, object) => sum + (object._max.size ?? 0n), 0n).toString(),
    metrics: Object.fromEntries(metrics.map(({ name, count }) => [name, count.toString()])),
    profiles: profiles.map((p) => ({
      profileId: p.profileId,
      name: names.find((n) => n.id === p.profileId)?.name ?? p.profileId,
      files: p._count,
      size: (p._sum.size ?? 0n).toString()
    }))
  }
}
