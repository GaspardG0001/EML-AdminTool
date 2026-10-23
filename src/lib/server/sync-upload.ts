import { lockSyncObject } from './sync-maintenance'
import { recordSyncMetric } from './sync-metrics'
import { assertSyncWritable, checkVersion } from '$lib/server/sync-api'
import { Prisma } from '@prisma/client'
import { db } from '$lib/server/db'
import {
  assertSyncEnabled,
  getSyncProfile,
  getSyncRuntimeConfig,
  getSyncStorage,
  isSyncPathAllowed,
  makeObjectKey,
  objectExistsWithChecksum,
  signUploadUrl,
  SyncApiError,
  toS3Checksum
} from '$lib/server/sync'

import type { UploadRequest } from './sync'
export async function prepareSyncUpload(playerId: string, profileId: string, input: UploadRequest) {
  assertSyncEnabled()
  await assertSyncWritable()
  const [syncProfile, storage] = await Promise.all([getSyncProfile(profileId), getSyncStorage()])

  if (!isSyncPathAllowed(input.path, syncProfile.rules)) {
    throw new SyncApiError('This path is not enabled for synchronization', 'PATH_NOT_ALLOWED', 403)
  }

  const device = await db.playerDevice.findUnique({
    where: {
      playerId_deviceUuid: {
        playerId: playerId,
        deviceUuid: input.deviceId
      }
    }
  })
  if (!device) throw new SyncApiError('Device does not belong to this player', 'DEVICE_NOT_FOUND', 403)

  const config = getSyncRuntimeConfig()
  const maxFileBytes = syncProfile.maxFileBytes ?? config.defaultMaxFileSize
  if (input.size > maxFileBytes) throw new SyncApiError('File exceeds the configured size limit', 'FILE_TOO_LARGE', 413)

  const objectKey = makeObjectKey(playerId, profileId, input.hash)
  let uploadRequired = true
  const expiresAt = new Date(Date.now() + storage.signedUrlTtl * 1000)

  const upload = await db.$transaction(
    async (tx) => {
      await lockSyncObject(tx, objectKey)
      const currentFile = await tx.syncFile.findUnique({
        where: {
          playerId_profileId_path: {
            playerId: playerId,
            profileId: profileId,
            path: input.path
          }
        }
      })
      const actualVersion = currentFile?.version ?? null
      checkVersion(actualVersion, input.baseVersion)

      const quotaScope = {
        playerId: playerId,
        ...(syncProfile.maxStorageBytes !== null ? { profileId: profileId } : {})
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

      uploadRequired = !(await objectExistsWithChecksum(storage, objectKey, input.size, input.hash))
      const created = await tx.syncUpload.create({
        data: {
          playerId: playerId,
          profileId: profileId,
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
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 }
  )

  const uploadUrl = uploadRequired ? await signUploadUrl(storage, objectKey, input.hash, input.size) : null
  await recordSyncMetric('uploads_prepared')
  return {
    uploadRequired,
    uploadId: upload.id,
    ...(uploadUrl
      ? {
          uploadUrl,
          uploadHeaders: { 'x-amz-checksum-sha256': toS3Checksum(input.hash) },
          expiresAt: expiresAt.toISOString()
        }
      : {})
  }
}
