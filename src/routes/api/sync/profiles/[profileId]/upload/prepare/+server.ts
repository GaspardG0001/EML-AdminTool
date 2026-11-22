import { authenticateSyncPlayer, assertSyncProfileAccess, parseUploadRequest, readSyncJson, syncErrorResponse } from '$lib/server/sync'
import { prepareSyncUpload } from '$lib/server/sync-upload'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const player = await authenticateSyncPlayer(request)
    await assertSyncProfileAccess(request, params.profileId)
    return Response.json(await prepareSyncUpload(player.id, params.profileId, parseUploadRequest(await readSyncJson(request))))
  } catch (err) { return syncErrorResponse(err) }
}
