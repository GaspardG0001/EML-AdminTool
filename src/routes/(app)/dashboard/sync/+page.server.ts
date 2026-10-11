import { error, redirect, type Actions } from '@sveltejs/kit'
import { fail } from '$lib/server/action'
import { db } from '$lib/server/db'
import { encryptS3Credential } from '$lib/server/s3-configuration'
import type { PageServerLoad } from './$types'
import { s3ConfigurationSchema } from '$lib/utils/validations'
import { NotificationCode } from '$lib/utils/notifications'
import { ServerError } from '$lib/utils/errors'

const s3ConfigurationId = '1'

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
        endpoint: true
      }
    })

    return {
      configuration: configuration
        ? {
            region: configuration.region,
            bucket: configuration.bucket,
            endpoint: configuration.endpoint,
            credentialsConfigured: true
          }
        : null
    }
  } catch (err) {
    console.error('Failed to load S3 configuration:', err)
    throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
  }
}) satisfies PageServerLoad

export const actions: Actions = {
  save: async (event) => {
    if (!event.locals.user?.isAdmin && !event.locals.user?.p_sync) {
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

      return { success: true }
    } catch (err) {
      if (err instanceof ServerError) {
        return fail(event, err.httpStatus, { failure: err.code })
      }

      console.error('Failed to save S3 configuration:', err)
      throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
    }
  }
}