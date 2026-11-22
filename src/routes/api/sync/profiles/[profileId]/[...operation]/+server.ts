import { prepareSyncUpload } from '$lib/server/sync-upload'
import { Prisma } from '@prisma/client'
import {
  assertSyncEnabled,
  authenticateSyncPlayer,
  assertSyncProfileAccess,
  getSyncProfile,
  parseUploadRequest,
  readSyncJson,
  syncErrorResponse,
  SyncApiError
} from '$lib/server/sync'
import { deleteSyncFile, objectBody, prepareDownload, syncConfiguration, syncManifest, syncRevision, syncUsage } from '$lib/server/sync-api'
import type { RequestHandler } from './$types'

const handle: RequestHandler = async ({ request, params, url }) => {
  try {
    const player = await authenticateSyncPlayer(request)
    assertSyncEnabled()
    const profileId = params.profileId
    await assertSyncProfileAccess(request, profileId)
    const operation = params.operation
    if (request.method === 'GET') {
      if (operation === 'config') return Response.json(await syncConfiguration(profileId))
      if (operation === 'usage') return Response.json(await syncUsage(player.id, profileId))
      await getSyncProfile(profileId)
      if (operation === 'revision') return Response.json(await syncRevision(player.id, profileId))
      if (operation === 'manifest') return Response.json(await syncManifest(player.id, profileId, url))
    }
    if (request.method === 'POST' && operation === 'uploads/prepare') {
      const body = objectBody(await readSyncJson(request))
      if (!Array.isArray(body.files) || !body.files.length || body.files.length > 100)
        throw new SyncApiError('Expected 1 to 100 files', 'INVALID_REQUEST', 400)
      const files = []
      for (const file of body.files) {
        let path: unknown = null
        try {
          const entry = objectBody(file)
          path = typeof entry.path === 'string' ? entry.path : null
          const input = parseUploadRequest({ ...entry, deviceId: entry.deviceId ?? body.deviceId })
          files.push({ path: input.path, ...(await prepareSyncUpload(player.id, profileId, input)) })
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034')
            err = new SyncApiError('Concurrent modification; retry', 'VERSION_CONFLICT', 409)
          if (!(err instanceof SyncApiError)) throw err
          files.push({ path, error: err.code, message: err.message, status: err.status })
        }
      }
      return Response.json({ files })
    }
    if (request.method === 'POST' && operation === 'download')
      return Response.json(await prepareDownload(player.id, profileId, await readSyncJson(request)))
    if (request.method === 'POST' && operation === 'download/batch') {
      const body = objectBody(await readSyncJson(request))
      if (!Array.isArray(body.paths) || body.paths.length < 1 || body.paths.length > 100)
        throw new SyncApiError('Expected 1 to 100 paths', 'INVALID_REQUEST', 400)
      // Sequential signing bounds resource usage for a large batch.
      const files = []
      for (const path of body.paths) files.push(await prepareDownload(player.id, profileId, { path }))
      return Response.json({ files })
    }
    if (request.method === 'DELETE' && operation === 'file')
      return Response.json(await deleteSyncFile(player.id, profileId, await readSyncJson(request)))
    throw new SyncApiError('Sync operation not found', 'NOT_FOUND', 404)
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034')
      return syncErrorResponse(new SyncApiError('Concurrent modification; retry', 'VERSION_CONFLICT', 409))
    return syncErrorResponse(err)
  }
}

export const GET = handle
export const POST = handle
export const DELETE = handle
