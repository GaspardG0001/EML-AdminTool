import { error } from '@sveltejs/kit'
import { db } from '$lib/server/db'
import { getFiles } from '$lib/server/files'
import { ServerError } from '$lib/utils/errors'
import { NotificationCode } from '$lib/utils/notifications'

const PAGE_SIZE = 25

export async function getNewsPageData(page: number, domain: string) {
  try {
    const [news, newsCount, newsCategories, newsTags] = await Promise.all([
      db.news
        .findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          include: { author: { select: { id: true, username: true } }, categories: true, tags: true }
        })
        .catch((err) => {
          console.error('Failed to load news:', err)
          throw new ServerError('Failed to load news', err, NotificationCode.DATABASE_ERROR, 500)
        }),
      db.news.count().catch((err) => {
        console.error('Failed to count news:', err)
        throw new ServerError('Failed to count news', err, NotificationCode.DATABASE_ERROR, 500)
      }),
      db.newsCategory.findMany({ orderBy: { name: 'asc' } }).catch((err) => {
        console.error('Failed to load news categories:', err)
        throw new ServerError('Failed to load news categories', err, NotificationCode.DATABASE_ERROR, 500)
      }),
      db.newsTag.findMany({ orderBy: { name: 'asc' } }).catch((err) => {
        console.error('Failed to load news tags:', err)
        throw new ServerError('Failed to load news tags', err, NotificationCode.DATABASE_ERROR, 500)
      })
    ])

    const images = await getFiles(domain, 'images')

    return { news, newsCount, newsPage: page, newsPageSize: PAGE_SIZE, newsCategories, newsTags, images }
  } catch (err) {
    if (err instanceof ServerError) throw error(err.httpStatus, { message: err.code })

    console.error('Unknown error:', err)
    throw error(500, { message: NotificationCode.INTERNAL_SERVER_ERROR })
  }
}