import { getSyncStatistics } from '$lib/server/sync-metrics'
import { getSyncPlayerQuota } from '$lib/server/sync'
import { error, fail as formFail, redirect, type Actions } from '@sveltejs/kit'
import { fail } from '$lib/server/action'
import { db } from '$lib/server/db'
import { decryptS3Credential, encryptS3Credential } from '$lib/server/s3-configuration'
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import type { PageServerLoad } from './$types'
import { s3ConfigurationSchema } from '$lib/utils/validations'
import { NotificationCode } from '$lib/utils/notifications'
import { ServerError } from '$lib/utils/errors'

const s3ConfigurationId = '1'

// Returns null when the bucket is reachable, otherwise a short error description.
async function checkS3Connection(config: {
  region: string
  bucket: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
}): Promise<string | null> {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: process.env.SYNC_S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 1,
    requestHandler: { requestTimeout: 10000, connectionTimeout: 5000 }
  })

  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
    return null
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error'
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
    return status ? `${name} (HTTP ${status})` : name
  } finally {
    client.destroy()
  }
}

export const load = (async (event) => {
  if (!event.locals.user?.isAdmin && !event.locals.user?.p_sync) {
    throw redirect(303, '/dashboard')
  }

  try {
    const configuration = await db.s3Configuration.findUnique({
      where: { id: s3ConfigurationId },
      select: {
        region: true,
        bucket: true,
        endpoint: true,
        accessKeyIdEncrypted: true
      }
    })

    const search = (event.url.searchParams.get('search') ?? '').slice(0, 100)
    const cursor = event.url.searchParams.get('cursor') || undefined
    const players = await db.player.findMany({
      where: { ...(search ? { OR: [{ minecraftName: { contains: search, mode: 'insensitive' } }, { minecraftUuid: { contains: search.replace(/-/g, '').toLowerCase() } }] } : {}), ...(cursor ? { id: { gt: cursor } } : {}) },
      include: { _count: { select: { devices: true, syncFiles: { where: { deleted: false } } } }, syncStates: { select: { updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 1 } }, orderBy: { id: 'asc' }, take: 51
    })
    const usage = await db.syncFile.groupBy({ by: ['playerId'], where: { playerId: { in: players.slice(0, 50).map((p) => p.id) }, deleted: false }, _sum: { size: true } })
    return {
      statistics: await getSyncStatistics(), search,
      playerQuotaBytes: (await getSyncPlayerQuota()).toString(),
      players: players.slice(0, 50).map((p) => ({ ...p, storageBytes: (usage.find((u) => u.playerId === p.id)?._sum.size ?? 0n).toString() })), nextCursor: players.length > 50 ? players[49].id : null,
      canConfigure: event.locals.user?.isAdmin || [1, 3].includes(event.locals.user?.p_sync ?? 0),
      profiles: await db.profile.findMany({ select: { id: true, name: true, syncProfile: { select: { enabled: true } } }, orderBy: { name: 'asc' } }),
      configuration: configuration
        ? {
            region: configuration.region,
            bucket: configuration.bucket,
            endpoint: configuration.endpoint,
            accessKeyId: decryptS3Credential(configuration.accessKeyIdEncrypted),
            credentialsConfigured: true
          }
        : null
    }
  } catch (err) {
    console.error('Failed to load synchronization dashboard:', err)
    throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
  }
}) satisfies PageServerLoad

export const actions = {
  saveQuota: async (event) => {
    if (!event.locals.user?.isAdmin && ![1, 3].includes(event.locals.user?.p_sync ?? 0)) {
      event.locals.logStatus = 403
      return formFail(403, { quotaError: 'Vous ne pouvez pas modifier le quota.' })
    }

    const value = (await event.request.formData()).get('playerQuotaBytes')
    if (typeof value !== 'string' || !/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n) {
      event.locals.logStatus = 400
      return formFail(400, { quotaError: 'Indiquez un nombre entier d’octets valide.' })
    }

    const playerQuotaBytes = BigInt(value)
    await db.$transaction(async (tx) => {
      await tx.syncConfiguration.upsert({
        where: { id: '1' },
        create: { id: '1', playerQuotaBytes },
        update: { playerQuotaBytes }
      })
      await tx.log.create({
        data: {
          userId: event.locals.user!.id,
          action: 'sync.quota.modified',
          details: JSON.stringify({ playerQuotaBytes: playerQuotaBytes.toString() })
        }
      })
    })
    return { quotaSaved: true }
  },
  save: async (event) => {
    if (!event.locals.user?.isAdmin && ![1, 3].includes(event.locals.user?.p_sync ?? 0)) {
      return fail(event, 403, { failure: NotificationCode.FORBIDDEN })
    }

    const form = await event.request.formData()
    const result = s3ConfigurationSchema.safeParse({
      region: form.get('region'),
      accessKeyId: form.get('accessKeyId'),
      secretAccessKey: form.get('secretAccessKey'),
      bucket: form.get('bucket'),
      endpoint: form.get('endpoint')
    })

    if (!result.success) {
      return fail(event, 400, { failure: NotificationCode.INVALID_INPUT })
    }

    try {
      const current = await db.s3Configuration.findUnique({ where: { id: s3ConfigurationId } })
      const { region, accessKeyId, secretAccessKey, bucket, endpoint } = result.data
      let accessKeyIdEncrypted: string
      let secretAccessKeyEncrypted: string

      if (current) {
        accessKeyIdEncrypted = accessKeyId ? encryptS3Credential(accessKeyId) : current.accessKeyIdEncrypted
        secretAccessKeyEncrypted = secretAccessKey
          ? encryptS3Credential(secretAccessKey)
          : current.secretAccessKeyEncrypted
      } else {
        if (!accessKeyId || !secretAccessKey) {
          return fail(event, 400, { failure: NotificationCode.MISSING_INPUT })
        }

        accessKeyIdEncrypted = encryptS3Credential(accessKeyId)
        secretAccessKeyEncrypted = encryptS3Credential(secretAccessKey)
      }

      const connectionError = await checkS3Connection({
        region,
        bucket,
        endpoint,
        accessKeyId: decryptS3Credential(accessKeyIdEncrypted),
        secretAccessKey: decryptS3Credential(secretAccessKeyEncrypted)
      })
      if (connectionError) {
        return fail(event, 400, { failure: NotificationCode.S3_CONNECTION_FAILED, detail: connectionError })
      }

      await db.s3Configuration.upsert({
        where: { id: s3ConfigurationId },
        create: {
          id: s3ConfigurationId,
          region,
          accessKeyIdEncrypted,
          secretAccessKeyEncrypted,
          bucket,
          endpoint
        },
        update: {
          region,
          accessKeyIdEncrypted,
          secretAccessKeyEncrypted,
          bucket,
          endpoint
        }
      })

      await db.log.create({ data: { userId: event.locals.user!.id, action: 'sync.storage.configuration.modified' } })
      return { success: true }
    } catch (err) {
      if (err instanceof ServerError) {
        return fail(event, err.httpStatus, { failure: err.code })
      }

      console.error('Failed to save S3 configuration:', err)
      throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
    }
  }
} satisfies Actions
