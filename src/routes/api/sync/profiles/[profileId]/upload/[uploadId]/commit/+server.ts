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
  syncErrorResponse,
  SyncApiError,
  verifyUploadedObject
} from '$lib/server/sync'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const player = await authenticateSyncPlayer(request)
    assertSyncEnabled()
    const syncProfile = await getSyncProfile(params.profileId)

    const upload = await db.syncUpload.findFirst({
      where: {
        id: params.uploadId,
        playerId: player.id,
        profileId: params.profileId
      }
    })
    if (!upload) throw new SyncApiError('Upload session was not found', 'UPLOAD_NOT_FOUND', 404)
    if (upload.state !== 'PENDING') throw new SyncApiError('Upload session is no longer pending', 'UPLOAD_NOT_PENDING', 409)
    if (upload.expiresAt <= new Date()) {
      await db.syncUpload.update({ where: { id: upload.id }, data: { state: 'EXPIRED' } })
      throw new SyncApiError('Upload session has expired', 'UPLOAD_EXPIRED', 410)
    }
    if (!isSyncPathAllowed(upload.path, syncProfile.rules)) {
      throw new SyncApiError('This path is no longer enabled for synchronization', 'PATH_NOT_ALLOWED', 403)
    }

    const storage = await getSyncStorage()
    await verifyUploadedObject(storage, upload.objectKey, upload.size, upload.hash)

    const committed = await db.$transaction(
      async (tx) => {
        const currentFile = await tx.syncFile.findUnique({
          where: {
            playerId_profileId_path: {
              playerId: player.id,
              profileId: params.profileId,
              path: upload.path
            }
          }
        })
        if ((currentFile?.version ?? null) !== upload.baseVersion) {
          throw new SyncApiError('File version has changed', 'VERSION_CONFLICT', 409)
        }
        if (currentFile && currentFile.version >= 2147483647) {
          throw new SyncApiError('File version limit has been reached', 'VERSION_LIMIT_REACHED', 409)
        }

        const config = getSyncRuntimeConfig()
        const maxFileBytes = syncProfile.maxFileBytes ?? config.defaultMaxFileSize
        if (upload.size > maxFileBytes) {
          throw new SyncApiError('File exceeds the configured size limit', 'FILE_TOO_LARGE', 413)
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
              id: { not: upload.id },
              state: 'PENDING',
              expiresAt: { gt: new Date() }
            },
            _sum: { reservedBytes: true }
          })
        ])
        const oldSize = currentFile && !currentFile.deleted ? currentFile.size : 0n
        const finalUsage = (activeFiles._sum.size ?? 0n) - oldSize + upload.size + (pendingUploads._sum.reservedBytes ?? 0n)
        const quota = syncProfile.maxStorageBytes ?? config.defaultPlayerQuota
        if (finalUsage > quota) {
          throw new SyncApiError('Player storage quota would be exceeded', 'QUOTA_EXCEEDED', 413)
        }

        const version = (currentFile?.version ?? 0) + 1
        const file = await tx.syncFile.upsert({
          where: {
            playerId_profileId_path: {
              playerId: player.id,
              profileId: params.profileId,
              path: upload.path
            }
          },
          create: {
            playerId: player.id,
            profileId: params.profileId,
            path: upload.path,
            hash: upload.hash,
            size: upload.size,
            version,
            deleted: false,
            objectKey: upload.objectKey,
            deviceId: upload.deviceId
          },
          update: {
            hash: upload.hash,
            size: upload.size,
            version,
            deleted: false,
            objectKey: upload.objectKey,
            deviceId: upload.deviceId
          }
        })

        const syncState = await tx.playerSyncState.upsert({
          where: {
            playerId_profileId: {
              playerId: player.id,
              profileId: params.profileId
            }
          },
          create: { playerId: player.id, profileId: params.profileId, revision: 1n },
          update: { revision: { increment: 1n } }
        })

        const updatedUpload = await tx.syncUpload.updateMany({
          where: {
            id: upload.id,
            state: 'PENDING',
            expiresAt: { gt: new Date() }
          },
          data: { state: 'COMMITTED', committedAt: new Date() }
        })
        if (updatedUpload.count !== 1) {
          throw new SyncApiError('Upload session is no longer pending', 'UPLOAD_NOT_PENDING', 409)
        }

        return { file, revision: syncState.revision }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )

    return json({
      success: true,
      file: {
        path: committed.file.path,
        hash: committed.file.hash,
        version: committed.file.version
      },
      revision: committed.revision.toString()
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      return syncErrorResponse(new SyncApiError('File version has changed', 'VERSION_CONFLICT', 409))
    }
    return syncErrorResponse(err)
  }
}
