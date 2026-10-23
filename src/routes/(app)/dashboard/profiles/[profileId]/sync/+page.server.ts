import { error, fail, redirect } from '@sveltejs/kit'
import { db } from '$lib/server/db'
import { getSyncRuntimeConfig } from '$lib/server/sync'
import { globToRegExp } from '$lib/sync/paths'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user?.isAdmin && !locals.user?.p_sync) throw redirect(303, '/dashboard')
  const profile = await db.profile.findUnique({
    where: { id: params.profileId },
    select: { id: true, name: true, syncProfile: { include: { rules: { orderBy: { id: 'asc' } } } } }
  })
  if (!profile) throw error(404, 'Profile not found')
  const config = getSyncRuntimeConfig()
  return {
    canConfigure: locals.user?.isAdmin || [1, 3].includes(locals.user?.p_sync ?? 0),
    profile,
    globallyEnabled: process.env.SYNC_ENABLED === 'true',
    defaults: { maxStorageBytes: config.defaultPlayerQuota.toString(), maxFileBytes: config.defaultMaxFileSize.toString() }
  }
}

export const actions: Actions = {
  default: async ({ locals, params, request }) => {
    if (!locals.user?.isAdmin && ![1, 3].includes(locals.user?.p_sync ?? 0)) throw error(403)
    const form = await request.formData()
    try {
      const limit = (key: string) => {
        const value = form.get(key)
        if (value === '') return null
        if (typeof value !== 'string' || !/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error('Invalid storage limit')
        return BigInt(value)
      }
      const paths = form.getAll('path')
      const actions = form.getAll('action')
      if (paths.length > 200 || paths.length !== actions.length) throw new Error('Invalid rules')
      const rules = paths.flatMap((path, i) => {
        if (path === '') return []
        if (typeof path !== 'string' || !['INCLUDE', 'EXCLUDE'].includes(String(actions[i]))) throw new Error('Invalid rule')
        const normalized = path.replace(/\\/g, '/')
        globToRegExp(normalized)
        return [{ path: normalized, action: actions[i] as 'INCLUDE' | 'EXCLUDE', enabled: form.get(`enabled-${i}`) === 'on' }]
      })
      const data = { enabled: form.get('enabled') === 'on', maxStorageBytes: limit('maxStorageBytes'), maxFileBytes: limit('maxFileBytes') }
      await db.$transaction(async (tx) => {
        const profile = await tx.syncProfile.upsert({
          where: { profileId: params.profileId },
          create: { profileId: params.profileId, ...data },
          update: data
        })
        await tx.syncRule.deleteMany({ where: { syncProfileId: profile.id } })
        await tx.syncRule.createMany({ data: rules.map((r) => ({ ...r, syncProfileId: profile.id })) })
        await tx.log.create({
          data: {
            userId: locals.user!.id,
            action: 'sync.configuration.modified',
            details: JSON.stringify({
              profileId: params.profileId,
              ...data,
              maxStorageBytes: data.maxStorageBytes?.toString(),
              maxFileBytes: data.maxFileBytes?.toString(),
              rules
            })
          }
        })
      })
      return { success: true }
    } catch {
      return fail(400, { message: 'Vérifiez les limites et les chemins relatifs des règles.' })
    }
  }
}
