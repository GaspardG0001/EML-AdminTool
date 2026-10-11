import { json } from '@sveltejs/kit'
import { Prisma } from '@prisma/client'
import { db } from '$lib/server/db'
import {
  assertSyncEnabled,
  authenticateSyncPlayer,
  getSyncProfile,
  getSyncRuntimeConfig,
  getSyncStorage,
  isSyncPathAllowed,
  makeObjectKey,
  objectExistsWithChecksum,
  parseUploadRequest,
  readSyncJson,
  signUploadUrl,
  syncErrorResponse,
  SyncApiError,
  toS3Checksum
} from '$lib/server/sync'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const player = await authenticateSyncPlayer(request)
    assertSyncEnabled()

    const input = parseUploadRequest(await readSyncJson(request))
    const [syncProfile, storage] = await Promise.all([getSyncProfile(params.profileId), getSyncStorage()])

    if (!isSyncPathAllowed(input.path, syncProfile.rules)) {
      throw new SyncApiError('This path is not enabled for synchronization', 'PATH_NOT_ALLOWED', 403)
    }

    const device = await db.playerDevice.findUnique({
      where: {
        playerId_deviceUuid: {
          playerId: player.id,
          deviceUuid: input.deviceId
        }
      }
    })
    if (!device) throw new SyncApiError('Device does not belong to this player', 'DEVICE_NOT_FOUND', 403)

    const config = getSyncRuntimeConfig()
    const maxFileBytes = syncProfile.maxFileBytes ?? config.defaultMaxFileSize
    if (input.size > maxFileBytes) throw new SyncApiError('File exceeds the configured size limit', 'FILE_TOO_LARGE', 413)

    const objectKey = makeObjectKey(player.id, params.profileId, input.hash)
    const uploadRequired = !(await objectExistsWithChecksum(storage, objectKey, input.size, input.hash))
    const uploadUrl = uploadRequired ? await signUploadUrl(storage, objectKey, input.hash) : null
    const expiresAt = new Date(Date.now() + storage.signedUrlTtl * 1000)

    const upload = await db.$transaction(
      async (tx) => {
        const currentFile = await tx.syncFile.findUnique({
          where: {
            playerId_profileId_path: {
              playerId: player.id,
              profileId: params.profileId,
              path: input.path
            }
          }
        })
        const actualVersion = currentFile?.version ?? null
        if (actualVersion !== input.baseVersion) {
          throw new SyncApiError('File version has changed', 'VERSION_CONFLICT', 409)
        }

        const quotaScope = {
          playerId: player.id,
          ...(syncProfile.maxStorageBytes !== null ? { profileId: params.profileId } : {})
        }
        const [activeFiles, pendingUploads] = await Promise.all([
          tx.syncFile.aggregate({
            where: { ...quotaScope, deleted: false },
            _sum: { size: true }
          }),
          tx.syncUpload.aggregate({
            where: {
              ...quotaScope,
              state: 'PENDING',
              expiresAt: { gt: new Date() }
            },
            _sum: { reservedBytes: true }
          })
        ])

        const oldSize = currentFile && !currentFile.deleted ? currentFile.size : 0n
        const reservedBytes = input.size > oldSize ? input.size - oldSize : 0n
        const usedBytes = activeFiles._sum.size ?? 0n
        const alreadyReservedBytes = pendingUploads._sum.reservedBytes ?? 0n
        const quota = syncProfile.maxStorageBytes ?? config.defaultPlayerQuota
        if (usedBytes + alreadyReservedBytes + reservedBytes > quota) {
          throw new SyncApiError('Player storage quota would be exceeded', 'QUOTA_EXCEEDED', 413)
        }

        const created = await tx.syncUpload.create({
          data: {
            playerId: player.id,
            profileId: params.profileId,
            deviceId: device.id,
            path: input.path,
            hash: input.hash,
            size: input.size,
            baseVersion: input.baseVersion,
            objectKey,
            reservedBytes,
            expiresAt
          }
        })
        await tx.playerDevice.update({
          where: { id: device.id },
          data: { lastSeenAt: new Date() }
        })
        return created
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )

    return json({
      uploadRequired,
      uploadId: upload.id,
      ...(uploadUrl
        ? {
            uploadUrl,
            uploadHeaders: { 'x-amz-checksum-sha256': toS3Checksum(input.hash) },
            expiresAt: expiresAt.toISOString()
          }
        : {})
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      return syncErrorResponse(new SyncApiError('Concurrent update; retry upload preparation', 'VERSION_CONFLICT', 409))
    }
    return syncErrorResponse(err)
  }
}
