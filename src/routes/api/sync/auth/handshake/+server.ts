import { Prisma } from '@prisma/client'
import { db } from '$lib/server/db'
import { syncHandshakeLimiter, canRenewSyncPlayer } from '$lib/server/limiter'
import {
  assertSyncAuthConfigured,
  assertSyncEnabled,
  createSyncPlayerToken,
  getPlayerTokenTtlSeconds,
  parseSyncHandshakeRequest,
  readSyncJson,
  syncErrorResponse,
  SyncApiError,
  verifyMinecraftAccessToken
} from '$lib/server/sync'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const ip = getClientAddress()
  if (!syncHandshakeLimiter.canPerformAction(ip)) {
    return Response.json({ success: false, code: 'TOO_MANY_REQUESTS', message: 'Too many authentication attempts' }, { status: 429 })
  }

  try {
    assertSyncEnabled()
    assertSyncAuthConfigured()
    const input = parseSyncHandshakeRequest(await readSyncJson(request))
    const verifiedProfile = await verifyMinecraftAccessToken(input.accessToken)
    if (!canRenewSyncPlayer(verifiedProfile.uuid, getPlayerTokenTtlSeconds()))
      throw new SyncApiError('Too many player authentication attempts', 'TOO_MANY_REQUESTS', 429)

    const player = await db.$transaction(async (tx) => {
      const storedPlayer = await tx.player.upsert({
        where: { minecraftUuid: verifiedProfile.uuid },
        create: {
          minecraftUuid: verifiedProfile.uuid,
          minecraftName: verifiedProfile.name
        },
        update: {
          minecraftName: verifiedProfile.name
        }
      })

      await tx.playerDevice.upsert({
        where: {
          playerId_deviceUuid: {
            playerId: storedPlayer.id,
            deviceUuid: input.deviceId
          }
        },
        create: {
          playerId: storedPlayer.id,
          deviceUuid: input.deviceId,
          name: input.deviceName,
          platform: input.platform,
          arch: input.arch,
          launcherVersion: input.launcherVersion
        },
        update: {
          name: input.deviceName,
          platform: input.platform,
          arch: input.arch,
          launcherVersion: input.launcherVersion,
          lastSeenAt: new Date()
        }
      })

      return storedPlayer
    })

    const { token, expiresAt } = await createSyncPlayerToken(player.id)
    return Response.json({
      success: true,
      token,
      tokenType: 'Bearer',
      expiresAt: expiresAt.toISOString(),
      player: {
        minecraftUuid: player.minecraftUuid,
        minecraftName: player.minecraftName
      },
      deviceId: input.deviceId
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      return syncErrorResponse(new SyncApiError('Please retry player authentication', 'AUTH_RETRY_REQUIRED', 409), false)
    }
    return syncErrorResponse(err, false)
  }
}
