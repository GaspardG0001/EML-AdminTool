<script lang="ts">
  import { l } from '$lib/stores/language'
  import getEnv from '$lib/utils/env'
  import S3Configuration from '../../../../components/contents/S3Configuration.svelte'
  import { enhance } from '$app/forms'
  import { formatBytes } from '$lib/utils/format-bytes'
  import type { PageProps } from './$types'

  let { data, form }: PageProps = $props()

  const env = getEnv()
</script>

<svelte:head>
  <title>Sync • {env.name} AdminTool</title>
</svelte:head>

<header class="page-header">
  <h2>Sync</h2>
  <p>Stockage des joueurs, profils synchronisés et configuration du service.</p>
</header>

<section class="section">
  <div class="section-heading">
    <div>
      <h3>Joueurs</h3>
      <p>Consultez l’utilisation et l’activité de synchronisation de chaque joueur.</p>
    </div>
  </div>
  <form method="GET" class="player-search">
    <label for="player-search">Pseudo ou UUID</label>
    <input id="player-search" name="search" value={data.search} placeholder="Rechercher un joueur" />
    <button type="submit">Rechercher</button>
  </form>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Joueur</th><th>Appareils</th><th>Fichiers</th><th>Stockage utilisé</th><th>Dernière synchronisation</th></tr>
      </thead>
      <tbody>
        {#each data.players as player}
          <tr>
            <td><a href={`/dashboard/sync/players/${player.id}`}>{player.minecraftName ?? player.minecraftUuid}</a></td>
            <td>{player._count.devices}</td>
            <td>{player._count.syncFiles}</td>
            <td>{formatBytes(player.storageBytes)}</td>
            <td>{player.syncStates[0]?.updatedAt.toLocaleString() ?? '—'}</td>
          </tr>
        {:else}
          <tr><td colspan="5" class="empty-state">Aucun joueur trouvé.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if data.nextCursor}
    <a class="next-page" href={`?cursor=${data.nextCursor}&search=${encodeURIComponent(data.search)}`}>Page suivante</a>
  {/if}
</section>

<section class="section">
  <div class="section-heading">
    <div>
      <h3>Synchronisation par profil</h3>
      <p>Choisissez un profil pour modifier ses règles.</p>
    </div>
  </div>
  <ul class="profile-list">
    {#each data.profiles as profile}
      <li>
        <a href={`/dashboard/profiles/${profile.id}/sync`}>{profile.name}</a>
        <span class:enabled={profile.syncProfile?.enabled} class="status">
          {profile.syncProfile?.enabled ? 'Activée' : 'Désactivée'}
        </span>
      </li>
    {:else}
      <li class="empty-state">Aucun profil disponible.</li>
    {/each}
  </ul>
</section>

<section class="section quota-section">
  <div class="section-heading">
    <div>
      <h3>Quota par joueur</h3>
      <p>Partagé entre tous les profils. Une baisse du quota ne supprime pas les données existantes.</p>
    </div>
  </div>
  {#if form && 'quotaSaved' in form && form.quotaSaved}<p role="status">Quota enregistré.</p>{/if}
  {#if form && 'quotaError' in form && typeof form.quotaError === 'string'}<p role="alert">{form.quotaError}</p>{/if}
  <form method="POST" action="?/saveQuota" use:enhance>
    <fieldset disabled={!data.canConfigure} class="quota-fields">
      <label for="player-quota">Quota (octets)</label>
      <input
        id="player-quota"
        name="playerQuotaBytes"
        type="text"
        inputmode="numeric"
        pattern="[0-9]+"
        maxlength="19"
        value={data.playerQuotaBytes}
        required
      />
      {#if data.canConfigure}<button type="submit">Enregistrer</button>{/if}
    </fieldset>
  </form>
</section>

<section class="section">
  <div class="section-heading">
    <div><h3>{$l.dashboard.s3Configuration.title}</h3></div>
  </div>
  {#if data.canConfigure}<S3Configuration configuration={data.configuration} />{:else}<p>Accès en lecture seule.</p>{/if}
</section>

<style lang="scss">
  @use '../../../../../static/scss/dashboard.scss';

  .page-header {
    margin-bottom: 28px;

    h2 {
      margin-bottom: 8px;
    }

    p {
      margin: 0;
      color: #707070;
    }
  }

  section.section {
    margin-top: 24px;
    padding: 28px;
  }

  .section-heading {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 20px;

    p {
      margin: 6px 0 0;
      color: #707070;
      font-size: 14px;
    }
  }

  .player-search {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) auto;
    align-items: end;
    gap: 12px;
    max-width: 620px;
    margin-bottom: 20px;

    label {
      grid-column: 1 / -1;
      margin: 0;
    }

    input {
      box-sizing: border-box;
      width: 100%;
      margin: 0;
    }

    button {
      margin: 0;
      white-space: nowrap;
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
    white-space: nowrap;
  }

  th,
  td {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border-color);
  }

  th {
    color: #707070;
    font-size: 13px;
    font-weight: 500;
  }

  .empty-state {
    padding: 18px 14px;
    color: #707070;
    text-align: center;
  }

  .next-page {
    margin-top: 18px;
  }

  .profile-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;

    li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
    }

    .empty-state {
      grid-column: 1 / -1;
    }
  }

  .status {
    color: #707070;
    font-size: 13px;
    white-space: nowrap;

    &.enabled {
      color: var(--green-color);
    }
  }

  .quota-fields {
    display: grid;
    grid-template-columns: minmax(180px, 420px) auto;
    align-items: end;
    gap: 12px;
    border: 0;
    padding: 0;

    label {
      grid-column: 1 / -1;
      margin: 0;
    }

    input {
      box-sizing: border-box;
      width: 100%;
      margin: 0;
    }

    button {
      margin: 0;
    }
  }

  @media (max-width: 700px) {
    section.section {
      padding: 22px 18px;
    }

    .player-search,
    .quota-fields {
      grid-template-columns: 1fr;

      label {
        grid-column: auto;
      }

      button {
        width: 100%;
      }
    }
  }
</style>
