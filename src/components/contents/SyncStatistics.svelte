<script lang="ts">
  import type { getSyncStatistics } from '$lib/server/sync-metrics'
  import { formatBytes } from '$lib/utils/format-bytes'
  let { statistics }: { statistics: Awaited<ReturnType<typeof getSyncStatistics>> } = $props()
  const metricLabels: Record<string, string> = {
    conflicts: 'Conflits de version',
    downloads_prepared: 'Téléchargements préparés',
    quota_exceeded: 'Quotas dépassés',
    request_failures: 'Requêtes échouées',
    storage_failures: 'Erreurs de stockage',
    uploads_committed: 'Envois terminés',
    uploads_prepared: 'Envois préparés'
  }
</script>

<h3>Vue d’ensemble</h3>
{#if !statistics.metricsAvailable}
  <p role="status">Les compteurs d’activité sont temporairement indisponibles.</p>
{/if}
<dl class="summary">
  <div class="summary-card">
    <dt>Joueurs</dt>
    <dd>{statistics.players}</dd>
  </div>
  <div class="summary-card">
    <dt>Appareils</dt>
    <dd>{statistics.devices}</dd>
  </div>
  <div class="summary-card">
    <dt>Fichiers actifs</dt>
    <dd>{statistics.files}</dd>
  </div>
  <div class="summary-card">
    <dt>Stockage logique</dt>
    <dd>{formatBytes(statistics.logicalBytes)}</dd>
  </div>
  <div class="summary-card">
    <dt>Stockage physique</dt>
    <dd>{formatBytes(statistics.referencedPhysicalBytes)}</dd>
  </div>
  <div class="summary-card">
    <dt>Envois en attente</dt>
    <dd>{statistics.pending}</dd>
  </div>
</dl>
{#if statistics.profiles.length}
  <h4>Stockage par profil</h4>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Profil</th><th>Fichiers</th><th>Stockage</th></tr></thead>
      <tbody>
        {#each statistics.profiles as profile}
          <tr><td>{profile.name}</td><td>{profile.files}</td><td>{formatBytes(profile.size)}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
{#if Object.keys(statistics.metrics).length}
  <details class="activity-details">
    <summary>Compteurs d’activité</summary>
    <dl class="activity-metrics">
      {#each Object.entries(statistics.metrics) as [name, count]}
        <div>
          <dt>{metricLabels[name] ?? name}</dt>
          <dd>{count}</dd>
        </div>
      {/each}
    </dl>
  </details>
{/if}

<style lang="scss">
  h3 {
    margin: 0 0 18px;
  }

  h4 {
    margin: 28px 0 12px;
    font-size: 15px;
    font-weight: 500;
  }

  .summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
    margin: 0;
  }

  .summary-card {
    min-width: 0;
    padding: 16px;
    border: 1px solid var(--border-color);
    border-radius: 7px;
    background: var(--background-light-color);

    dt {
      color: #707070;
      font-size: 13px;
    }

    dd {
      margin: 8px 0 0;
      font-size: 20px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
  }

  .table-wrap {
    max-width: 100%;
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
  }

  th,
  td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color);
  }

  th {
    color: #707070;
    font-size: 13px;
    font-weight: 500;
  }

  .activity-details {
    margin-top: 20px;
    color: #707070;

    summary {
      width: fit-content;
      cursor: pointer;
    }
  }

  .activity-metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 8px 20px;
    margin: 14px 0 0;

    div {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border-color);
    }

    dd {
      margin: 0;
      font-weight: 500;
      color: var(--text-dark-color);
    }
  }
</style>
