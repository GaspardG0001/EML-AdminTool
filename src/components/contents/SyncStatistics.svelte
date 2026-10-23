<script lang="ts">
  import type { getSyncStatistics } from '$lib/server/sync-metrics'
  let { statistics }: { statistics: Awaited<ReturnType<typeof getSyncStatistics>> } = $props()
  const bytes = (value: string) => `${(Number(value) / 1073741824).toFixed(2)} GiB`
</script>

<h3>Player Sync</h3>
<dl>
  <div>
    <dt>Joueurs</dt>
    <dd>{statistics.players}</dd>
  </div>
  <div>
    <dt>Appareils</dt>
    <dd>{statistics.devices}</dd>
  </div>
  <div>
    <dt>Fichiers actifs</dt>
    <dd>{statistics.files}</dd>
  </div>
  <div>
    <dt>Stockage logique</dt>
    <dd>{bytes(statistics.logicalBytes)}</dd>
  </div>
  <div>
    <dt>Stockage physique référencé</dt>
    <dd>{bytes(statistics.referencedPhysicalBytes)}</dd>
  </div>
  <div>
    <dt>Uploads en attente</dt>
    <dd>{statistics.pending}</dd>
  </div>
  {#each Object.entries(statistics.metrics) as [name, count]}<div>
      <dt>{name}</dt>
      <dd>{count}</dd>
    </div>{/each}
</dl>
<table>
  <thead><tr><th>Profil</th><th>Fichiers</th><th>Stockage logique</th></tr></thead><tbody>
    {#each statistics.profiles as profile}<tr><td>{profile.name}</td><td>{profile.files}</td><td>{bytes(profile.size)}</td></tr>{/each}
  </tbody>
</table>
<p>Le stockage physique référencé exclut les objets en attente de nettoyage.</p>

<style>
  dl {
    display: flex;
    flex-wrap: wrap;
    gap: 1.5rem;
  }
  dd {
    margin: 0.5rem 0;
    font-size: 1.3rem;
  }
</style>
