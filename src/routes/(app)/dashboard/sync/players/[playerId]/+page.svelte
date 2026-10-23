<script lang="ts">
  import { enhance } from '$app/forms'
  import { page } from '$app/state'
  import type { PageProps } from './$types'
  let { data, form }: PageProps = $props()
</script>

<h2>{data.player.minecraftName ?? data.player.minecraftUuid}</h2>
<a href="/dashboard/sync">Retour à Sync</a>
<p>UUID : {data.player.minecraftUuid}</p>
<section class="section">
  <h3>Appareils</h3>
  {#each data.player.devices as device}<p>{device.name} — {device.platform} {device.arch ?? ''} — {device.lastSeenAt.toLocaleString()}</p>{/each}
  <h3>Profils</h3>
  {#each data.player.syncStates as state}
    {@const usage = data.usage.find((u) => u.profileId === state.profileId)}
    <p>
      <a href={`?profileId=${state.profileId}`}>{state.profile.name}</a> : {usage?._count ?? 0} fichiers, {usage?._sum.size?.toString() ?? 0} octets — {state.updatedAt.toLocaleString()}
    </p>
  {/each}
  <h3>Métadonnées des fichiers</h3>
  <table>
    <thead><tr><th>Chemin</th><th>Version</th><th>Octets</th><th>État</th></tr></thead><tbody>
      {#each data.files as file}<tr
          ><td>{file.path}</td><td>{file.version}</td><td>{file.size.toString()}</td><td>{file.deleted ? 'Supprimé' : 'Actif'}</td></tr
        >{/each}
    </tbody>
  </table>
  {#if data.nextCursor}<a href={`?cursor=${data.nextCursor}&profileId=${page.url.searchParams.get('profileId') ?? ''}`}>Page suivante</a>{/if}
</section>
{#if data.canDelete}
  <section class="section">
    <h3>Supprimer les données synchronisées</h3>
    <p>
      Les fichiers locaux ne sont pas supprimés. Les références distantes seront effacées et le stockage sera nettoyé après expiration des URLs
      temporaires.
    </p>
    <form method="POST" action="?/deleteData" use:enhance>
      <label
        >Portée <select name="profileId"
          ><option value="">Tous les profils et appareils</option>{#each data.player.syncStates as state}<option value={state.profileId}
              >{state.profile.name}</option
            >{/each}</select
        ></label
      >
      <label>Confirmer avec l’UUID <input name="confirmation" autocomplete="off" required /></label>
      <button type="submit">Supprimer les données</button>
    </form>
    {#if form?.message}<p role="alert">{form.message}</p>{/if}
    {#if form?.success}<p role="status">Données supprimées. Nettoyage du stockage programmé.</p>{/if}
  </section>
{/if}

<style lang="scss">
  @use '../../../../../../../static/scss/dashboard.scss';
  table {
    width: 100%;
    text-align: left;
    overflow-wrap: anywhere;
  }
  label {
    display: block;
    margin: 1rem 0;
  }
</style>
