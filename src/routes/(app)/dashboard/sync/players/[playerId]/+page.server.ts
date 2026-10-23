import { error, fail, redirect } from '@sveltejs/kit'
import { db } from '$lib/server/db'
import { deletePlayerSyncData } from '$lib/server/sync-maintenance'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals, params, url }) => {
  if (!locals.user?.isAdmin && !locals.user?.p_sync) throw redirect(303, '/dashboard')
  const player = await db.player.findUnique({
    where: { id: params.playerId },
    include: { devices: { orderBy: { lastSeenAt: 'desc' } }, syncStates: { include: { profile: { select: { name: true } } } } }
  })
  if (!player) throw error(404)
  const profileId = url.searchParams.get('profileId') || undefined
  const cursor = url.searchParams.get('cursor') || undefined
  const [usage, files] = await Promise.all([
    db.syncFile.groupBy({ by: ['profileId'], where: { playerId: player.id, deleted: false }, _sum: { size: true }, _count: true }),
    db.syncFile.findMany({
      where: { playerId: player.id, ...(profileId ? { profileId } : {}), ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: 101,
      omit: { objectKey: true }
    })
  ])
  return {
    player,
    usage,
    files: files.slice(0, 100),
    nextCursor: files.length > 100 ? files[99].id : null,
    canDelete: locals.user?.isAdmin || locals.user?.p_sync === 3
  }
}

export const actions: Actions = {
  deleteData: async ({ locals, params, request }) => {
    if (!locals.user?.isAdmin && locals.user?.p_sync !== 3) throw error(403)
    const form = await request.formData()
    const player = await db.player.findUnique({ where: { id: params.playerId } })
    if (!player || form.get('confirmation') !== player.minecraftUuid)
      return fail(400, { message: 'Saisissez l’UUID complet du joueur pour confirmer.' })
    const profileId = String(form.get('profileId') ?? '') || undefined
    await deletePlayerSyncData(locals.user!.id, player.id, profileId)
    return { success: true }
  }
}
