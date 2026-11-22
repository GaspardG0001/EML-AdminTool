<script lang="ts">
  import { enhance } from '$app/forms'
  import { page } from '$app/state'
  import { formatBytes } from '$lib/utils/format-bytes'
  import type { PageProps } from './$types'

  let { data, form }: PageProps = $props()
  let selectedProfileId = $derived(page.url.searchParams.get('profileId'))
</script>

<svelte:head>
  <title>{data.player.minecraftName ?? data.player.minecraftUuid} • Sync</title>
</svelte:head>

<header class="page-header">
  <a href="/dashboard/sync">← Sync</a>
  <h2>{data.player.minecraftName ?? data.player.minecraftUuid}</h2>
  <p class="player-id">UUID : <code>{data.player.minecraftUuid}</code></p>
</header>

<section class="section">
  <h3>Appareils</h3>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Appareil</th><th>Plateforme</th><th>Dernière activité</th></tr></thead>
      <tbody>
        {#each data.player.devices as device}
          <tr>
            <td>{device.name}</td>
            <td>{device.platform}{device.arch ? ` · ${device.arch}` : ''}</td>
            <td>{device.lastSeenAt.toLocaleString()}</td>
          </tr>
        {:else}
          <tr><td colspan="3" class="empty-state">Aucun appareil associé.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<section class="section">
  <h3>Utilisation par profil</h3>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Profil</th><th>Fichiers</th><th>Stockage</th><th>Dernière synchronisation</th></tr></thead>
      <tbody>
        {#each data.player.syncStates as state}
          {@const usage = data.usage.find((item) => item.profileId === state.profileId)}
          <tr>
            <td
              ><a href={`?profileId=${state.profileId}`} aria-current={selectedProfileId === state.profileId ? 'page' : undefined}
                >{state.profile.name}</a
              ></td
            >
            <td>{usage?._count ?? 0}</td>
            <td>{formatBytes(usage?._sum.size ?? 0n)}</td>
            <td>{state.updatedAt.toLocaleString()}</td>
          </tr>
        {:else}
          <tr><td colspan="4" class="empty-state">Aucune synchronisation pour ce joueur.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<section class="section">
  <div class="section-heading">
    <h3>Fichiers synchronisés</h3>
    {#if selectedProfileId}<a href="/dashboard/sync/players/{data.player.id}">Tous les profils</a>{/if}
  </div>
  <div class="table-wrap">
    <table class="files-table">
      <thead><tr><th>Chemin</th><th>Version</th><th>Taille</th><th>État</th></tr></thead>
      <tbody>
        {#each data.files as file}
          <tr>
            <td class="file-path">{file.path}</td>
            <td>{file.version}</td>
            <td>{formatBytes(file.size)}</td>
            <td>{file.deleted ? 'Supprimé' : 'Actif'}</td>
          </tr>
        {:else}
          <tr><td colspan="4" class="empty-state">Aucun fichier à afficher.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if data.nextCursor}
    <a class="next-page" href={`?cursor=${data.nextCursor}&profileId=${selectedProfileId ?? ''}`}>Page suivante</a>
  {/if}
</section>

{#if data.canDelete}
  <section class="section delete-section">
    <h3>Supprimer les données synchronisées</h3>
    <p>Les fichiers sur les appareils ne seront pas supprimés. Le stockage distant sera nettoyé après expiration des liens temporaires.</p>
    <form method="POST" action="?/deleteData" use:enhance class="delete-form">
      <label for="delete-profile">Profil concerné</label>
      <select id="delete-profile" name="profileId">
        <option value="">Tous les profils et appareils</option>
        {#each data.player.syncStates as state}
          <option value={state.profileId}>{state.profile.name}</option>
        {/each}
      </select>
      <label for="delete-confirmation">Confirmez avec l’UUID du joueur</label>
      <input id="delete-confirmation" name="confirmation" autocomplete="off" required />
      <button type="submit" class="primary danger">Supprimer les données</button>
    </form>
    {#if form?.message}<p role="alert">{form.message}</p>{/if}
    {#if form?.success}<p role="status">Données supprimées. Nettoyage du stockage programmé.</p>{/if}
  </section>
{/if}

<style lang="scss">
  @use '../../../../../../../static/scss/dashboard.scss';

  .page-header {
    margin-bottom: 28px;

    h2 {
      margin: 14px 0 4px;
    }

    .player-id {
      margin: 0;
      color: #707070;
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    code {
      font-family: 'JetBrains Mono', Consolas, monospace;
    }
  }

  section.section {
    margin-top: 24px;
    padding: 28px;

    h3 {
      margin: 0 0 16px;
    }
  }

  .section-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;

    h3 {
      margin-bottom: 16px;
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
    padding: 12px 14px;
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
  }

  th {
    color: #707070;
    font-size: 13px;
    font-weight: 500;
  }

  .file-path {
    min-width: 200px;
    max-width: 480px;
    overflow-wrap: anywhere;
    white-space: normal;
    font-family: 'JetBrains Mono', Consolas, monospace;
    font-size: 13px;
  }

  .empty-state {
    padding: 18px 14px;
    color: #707070;
    text-align: center;
  }

  .next-page {
    margin-top: 18px;
  }

  .delete-section {
    border-color: rgb(230, 200, 200) !important;
  }

  .delete-form {
    max-width: 460px;

    label {
      margin: 16px 0 5px;
    }

    select,
    input {
      box-sizing: border-box;
      width: 100%;
    }

    button {
      margin-top: 20px;
    }
  }

  @media (max-width: 700px) {
    section.section {
      padding: 22px 18px;
    }
  }
</style>
