import { db } from '$lib/server/db'
import { assertSyncEnabled, authenticateSyncPlayer, parseSyncHandshakeRequest, readSyncJson, syncErrorResponse } from '$lib/server/sync'
import { objectBody } from '$lib/server/sync-api'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ request }) => {
  try {
    const player = await authenticateSyncPlayer(request)
    assertSyncEnabled()
    const devices = await db.playerDevice.findMany({ where: { playerId: player.id }, omit: { playerId: true }, orderBy: { lastSeenAt: 'desc' } })
    return Response.json({ devices })
  } catch (err) {
    return syncErrorResponse(err)
  }
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    const player = await authenticateSyncPlayer(request)
    assertSyncEnabled()
    const body = objectBody(await readSyncJson(request))
    const input = parseSyncHandshakeRequest({
      accessToken: 'validated-player-token',
      deviceId: body.deviceUuid,
      deviceName: body.name,
      platform: body.platform,
      arch: body.arch,
      launcherVersion: body.launcherVersion
    })
    const data = {
      name: input.deviceName,
      platform: input.platform,
      arch: input.arch,
      launcherVersion: input.launcherVersion,
      lastSeenAt: new Date()
    }
    const device = await db.playerDevice.upsert({
      where: { playerId_deviceUuid: { playerId: player.id, deviceUuid: input.deviceId } },
      create: { playerId: player.id, deviceUuid: input.deviceId, ...data },
      update: data,
      omit: { playerId: true }
    })
    return Response.json({ device })
  } catch (err) {
    return syncErrorResponse(err)
  }
}
