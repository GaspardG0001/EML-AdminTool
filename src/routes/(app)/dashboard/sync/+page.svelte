<script lang="ts">
  import { l } from '$lib/stores/language'
  import getEnv from '$lib/utils/env'
  import S3Configuration from '../../../../components/contents/S3Configuration.svelte'
  import type { PageProps } from './$types'

  let { data }: PageProps = $props()

  const env = getEnv()
</script>

<svelte:head>
  <title>Sync • {env.name} AdminTool</title>
</svelte:head>

<h2>Sync</h2>

<section class="section">
  <h3>{$l.dashboard.s3Configuration.title}</h3>
  <S3Configuration configuration={data.configuration} />
</section>

<style lang="scss">
  @use '../../../../../static/scss/dashboard.scss';
</style>
