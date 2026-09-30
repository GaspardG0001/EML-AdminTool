import { error, redirect, type Actions } from '@sveltejs/kit'
import { fail } from '$lib/server/action'
import type { PageServerLoad } from './$types'
import { BusinessError, ServerError } from '$lib/utils/errors'
import { NotificationCode } from '$lib/utils/notifications'
import { deleteFile, uploadFile } from '$lib/server/files'
import { getNewsPageData } from '$lib/server/news-page'
import { newsCategorySchema, newsSchema, newsTagSchema } from '$lib/utils/validations'
import {
  addNews,
  addNewsCategory,
  addNewsTag,
  deleteNews,
  deleteNewsCategory,
  deleteNewsTag,
  getNewsById,
  getNewsCategoryById,
  getNewsTagById,
  updateNews,
  updateNewsCategory,
  updateNewsTag
} from '$lib/server/news'
import path_ from 'node:path'
import { randomBytes } from 'node:crypto'
import { getDomain } from '$lib/utils/utils'

export const load = (async (event) => {
  const user = event.locals.user
  const page = getPage(event.url.searchParams.get('page'))

  if (!user?.p_news) {
    throw redirect(303, '/dashboard')
  }

  return getNewsPageData(page, getDomain(event))
}) satisfies PageServerLoad

function getPage(value: string | null): number {
  const page = Number.parseInt(value ?? '1', 10)
  if (!Number.isFinite(page) || page < 1) return 1
  return page
}

export const actions: Actions = {
  addEditNews: async (event) => {
    const user = event.locals.user

    if (!user?.p_news) {
      throw redirect(303, '/dashboard')
    }

    const form = await event.request.formData()
    const raw = {
      newsId: form.get('news-id'),
      title: form.get('title'),
      content: form.get('content'),
      categoriesId: form.getAll('categories'),
      tagsId: form.getAll('tags')
    }

    const result = newsSchema.safeParse(raw)
    if (!result.success) {
      return fail(event, 400, { failure: JSON.parse(result.error.message)[0].message })
    }

    const { newsId, title, content, categoriesId, tagsId } = result.data

    const news = {
      title: title,
      content: content,
      authorId: user.id
    }

    try {
      if (newsId) {
        const existingNews = await getNewsById(newsId)
        if (!existingNews) {
          console.warn(`News with ID ${newsId} not found`)
          throw new BusinessError('News not found', NotificationCode.NOT_FOUND, 404)
        }

        if (user.id !== existingNews.authorId) {
          console.warn(`User ${user.id} is not the author of news ${newsId}`)
          throw new BusinessError('You are not the author of this news', NotificationCode.FORBIDDEN, 403)
        }

        await updateNews(newsId, news, categoriesId, tagsId)
      } else {
        await addNews(news, categoriesId ?? [], tagsId ?? [])
      }
    } catch (err) {
      if (err instanceof BusinessError) return fail(event, err.httpStatus, { failure: err.code })
      if (err instanceof ServerError) throw error(err.httpStatus, { message: err.code })

      console.error('Unknown error:', err)
      throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
    }
  },

  deleteNews: async (event) => {
    const user = event.locals.user

    if (!user?.p_news) {
      throw redirect(303, '/dashboard')
    }

    const form = await event.request.formData()
    const newsId = form.getAll('news-id')

    try {
      for (const id of newsId) {
        if (typeof id !== 'string') continue

        const news = await getNewsById(id)
        if (!news) {
          console.warn(`News with ID ${id} not found`)
          throw new BusinessError('News not found', NotificationCode.NOT_FOUND, 404)
        }

        if (user.id !== news.authorId && !user.isAdmin && user.p_news !== 2) {
          console.warn(`User ${user.id} is not the author of news ${id} and does not have permission to delete it`)
          throw new BusinessError('You are not the author of this news', NotificationCode.FORBIDDEN, 403)
        }

        await deleteNews(id)
      }
    } catch (err) {
      if (err instanceof BusinessError) return fail(event, err.httpStatus, { failure: err.code })
      if (err instanceof ServerError) throw error(err.httpStatus, { message: err.code })

      console.error('Unknown error:', err)
      throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
    }
  },

  uploadImages: async (event) => {
    const user = event.locals.user

    if (!user?.p_news) {
      throw redirect(303, '/dashboard')
    }

    const formData = await event.request.formData()
    const images = formData.getAll('images')

    try {
      for (const image of images) {
        if (!(image instanceof File)) continue

        const newName = `${randomBytes(8).toString('hex')}${path_.extname(image.name)}`
        const newImage = new File([image], newName, { type: image.type })

        await uploadFile('images', '', newImage)
      }
    } catch (err) {
      if (err instanceof BusinessError) return fail(event, err.httpStatus, { failure: err.message })
      if (err instanceof ServerError) throw error(err.httpStatus, { message: err.message })

      console.error('Unknown error:', err)
      throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
    }
  },

  deleteImage: async (event) => {
    const user = event.locals.user

    if (!user?.p_news) {
      throw redirect(303, '/dashboard')
    }

    const form = await event.request.formData()
    const imageName = form.get('image-name')

    try {
      if (typeof imageName !== 'string') return

      await deleteFile('images', imageName)
    } catch (err) {
      if (err instanceof BusinessError) return fail(event, err.httpStatus, { failure: err.message })
      if (err instanceof ServerError) throw error(err.httpStatus, { message: err.message })

      console.error('Unknown error:', err)
      throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
    }
  },

  addEditCategory: async (event) => {
    const user = event.locals.user

    if (!user?.p_newsCategories) {
      throw redirect(303, '/dashboard')
    }

    const form = await event.request.formData()
    const raw = {
      categoryId: form.get('category-id'),
      name: form.get('name')
    }

    const result = newsCategorySchema.safeParse(raw)
    if (!result.success) {
      return fail(event, 400, { failure: JSON.parse(result.error.message)[0].message })
    }

    const { categoryId, name } = result.data

    try {
      if (categoryId) {
        const category = await getNewsCategoryById(categoryId)
        if (!category) {
          console.warn(`News category with ID ${categoryId} not found`)
          throw new BusinessError('News category not found', NotificationCode.NOT_FOUND, 404)
        }

        await updateNewsCategory(categoryId, name)
      } else {
        await addNewsCategory(name)
      }
    } catch (err) {
      if (err instanceof BusinessError) return fail(event, err.httpStatus, { failure: err.code })
      if (err instanceof ServerError) throw error(err.httpStatus, { message: err.code })

      console.error('Unknown error:', err)
      throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
    }
  },

  deleteCategory: async (event) => {
    const user = event.locals.user

    if (!user?.p_newsCategories) {
      throw redirect(303, '/dashboard')
    }

    const form = await event.request.formData()
    const categoryId = form.get('category-id')

    try {
      if (typeof categoryId !== 'string') return

      await deleteNewsCategory(categoryId)
    } catch (err) {
      if (err instanceof BusinessError) return fail(event, err.httpStatus, { failure: err.code })
      if (err instanceof ServerError) throw error(err.httpStatus, { message: err.code })

      console.error('Unknown error:', err)
      throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
    }
  },

  addEditTag: async (event) => {
    const user = event.locals.user

    if (!user?.p_newsTags) {
      throw redirect(303, '/dashboard')
    }

    const form = await event.request.formData()
    const raw = {
      tagId: form.get('tag-id'),
      name: form.get('name'),
      color: form.get('color')
    }

    const result = newsTagSchema.safeParse(raw)
    if (!result.success) {
      return fail(event, 400, { failure: JSON.parse(result.error.message)[0].message })
    }

    const { tagId, name, color } = result.data

    try {
      if (tagId) {
        const tag = await getNewsTagById(tagId)
        if (!tag) {
          console.warn(`News tag with ID ${tagId} not found`)
          throw new BusinessError('News tag not found', NotificationCode.NOT_FOUND, 404)
        }

        await updateNewsTag(tagId, name, color)
      } else {
        await addNewsTag(name, color)
      }
    } catch (err) {
      if (err instanceof BusinessError) return fail(event, err.httpStatus, { failure: err.code })
      if (err instanceof ServerError) throw error(err.httpStatus, { message: err.code })

      console.error('Unknown error:', err)
      throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
    }
  },

  deleteTag: async (event) => {
    const user = event.locals.user

    if (!user?.p_newsTags) {
      throw redirect(303, '/dashboard')
    }

    const form = await event.request.formData()
    const tagId = form.get('tag-id')

    try {
      if (typeof tagId !== 'string') return

      await deleteNewsTag(tagId)
    } catch (err) {
      if (err instanceof BusinessError) return fail(event, err.httpStatus, { failure: err.code })
      if (err instanceof ServerError) throw error(err.httpStatus, { message: err.code })

      console.error('Unknown error:', err)
      throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
    }
  }
}

