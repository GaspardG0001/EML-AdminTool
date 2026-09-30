import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { getNewsPageData } from '$lib/server/news-page'
import { getDomain } from '$lib/utils/utils'

export const load = (async (event) => {
	if (!event.locals.user?.p_sync) {
		throw redirect(303, '/dashboard')
	}

	const page = Number.parseInt(event.url.searchParams.get('page') ?? '1', 10)
	return getNewsPageData(Number.isFinite(page) && page >= 1 ? page : 1, getDomain(event))
}) satisfies PageServerLoad