<script lang="ts">
  import SyncStatistics from '../../../../components/contents/SyncStatistics.svelte'
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
<section class="section"><SyncStatistics statistics={data.statistics} /></section>
<section class="section">
  <h3>Joueurs</h3>
  <form method="GET">
    <label>Rechercher un pseudo ou UUID <input name="search" value={data.search} /></label><button type="submit">Rechercher</button>
  </form>
  <table>
    <thead><tr><th>Joueur</th><th>Appareils</th><th>Fichiers</th><th>Octets</th><th>Dernière synchronisation</th></tr></thead><tbody>
      {#each data.players as player}<tr
          ><td><a href={`/dashboard/sync/players/${player.id}`}>{player.minecraftName ?? player.minecraftUuid}</a></td><td>{player._count.devices}</td
          ><td>{player._count.syncFiles}</td><td>{player.storageBytes}</td><td>{player.syncStates[0]?.updatedAt.toLocaleString() ?? '—'}</td></tr
        >{/each}
    </tbody>
  </table>
  {#if data.nextCursor}<a href={`?cursor=${data.nextCursor}&search=${encodeURIComponent(data.search)}`}>Page suivante</a>{/if}
</section>

<section class="section">
  <h3>Synchronisation par profil</h3>
  {#each data.profiles as profile}
    <p><a href={`/dashboard/profiles/${profile.id}/sync`}>{profile.name}</a> — {profile.syncProfile?.enabled ? 'Activée' : 'Désactivée'}</p>
  {/each}
</section>

<section class="section">
  <h3>{$l.dashboard.s3Configuration.title}</h3>
  {#if data.canConfigure}<S3Configuration configuration={data.configuration} />{:else}<p>Accès en lecture seule.</p>{/if}
</section>

<style lang="scss">
  @use '../../../../../static/scss/dashboard.scss';
</style>
