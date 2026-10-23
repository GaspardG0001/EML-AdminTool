<script lang="ts">
  import { enhance } from '$app/forms'
  import type { PageProps } from './$types'
  let { data, form }: PageProps = $props()
  const defaults = [
    { path: 'saves/**', action: 'INCLUDE', enabled: true },
    { path: 'XaeroWaypoints/**', action: 'INCLUDE', enabled: true },
    { path: 'journeymap/**', action: 'INCLUDE', enabled: true },
    { path: 'config/**', action: 'INCLUDE', enabled: true },
    { path: 'options.txt', action: 'INCLUDE', enabled: true },
    { path: 'saves/**/session.lock', action: 'EXCLUDE', enabled: true }
  ]
  let rules = $state(data.profile.syncProfile?.rules.map(({ path, action, enabled }) => ({ path, action: String(action), enabled })) ?? defaults)
</script>

<svelte:head><title>Synchronisation • {data.profile.name}</title></svelte:head>
<h2>{data.profile.name} — Synchronisation des données joueur</h2>
<a href="/dashboard/profiles">Profils</a> · <a href="/dashboard/sync">Stockage et joueurs</a>
{#if !data.globallyEnabled}<p>Le service est désactivé globalement. Définissez SYNC_ENABLED=true pour l’activer.</p>{/if}
{#if form?.success}<p role="status">Configuration enregistrée.</p>{/if}
{#if form?.message}<p role="alert">{form.message}</p>{/if}
<form method="POST" use:enhance>
  <section class="section">
    <fieldset disabled={!data.canConfigure}>
      <label><input type="checkbox" name="enabled" checked={data.profile.syncProfile?.enabled ?? false} /> Activer la synchronisation</label>
      <label
        >Quota par joueur (octets, vide = {data.defaults.maxStorageBytes})
        <input name="maxStorageBytes" inputmode="numeric" pattern="[0-9]*" value={data.profile.syncProfile?.maxStorageBytes?.toString() ?? ''} />
      </label>
      <label
        >Taille maximale par fichier (octets, vide = {data.defaults.maxFileBytes})
        <input name="maxFileBytes" inputmode="numeric" pattern="[0-9]*" value={data.profile.syncProfile?.maxFileBytes?.toString() ?? ''} />
      </label>
      <h3>Règles de synchronisation</h3>
      <p>Les exclusions sont prioritaires. Seuls les fichiers inclus sont synchronisés.</p>
      {#each rules as rule, i}
        <div class="rule">
          <input aria-label="Règle active" type="checkbox" name={`enabled-${i}`} bind:checked={rule.enabled} />
          <input aria-label="Chemin relatif" name="path" bind:value={rule.path} maxlength="1024" placeholder="saves/**" />
          <select aria-label="Action" name="action" bind:value={rule.action}
            ><option value="INCLUDE">Inclure</option><option value="EXCLUDE">Exclure</option></select
          >
          <button type="button" class="secondary" onclick={() => (rules = rules.filter((_, index) => index !== i))}>Supprimer</button>
        </div>
      {/each}
      <button
        type="button"
        class="secondary"
        disabled={rules.length >= 200}
        onclick={() => (rules = [...rules, { path: '', action: 'INCLUDE', enabled: true }])}>Ajouter une règle</button
      >
      <button type="submit">Enregistrer</button>
    </fieldset>
  </section>
</form>

<style lang="scss">
  @use '../../../../../../../static/scss/dashboard.scss';
  label {
    display: block;
    margin: 1rem 0;
  }
  .rule {
    display: flex;
    gap: 0.5rem;
    margin: 0.5rem 0;
    flex-wrap: wrap;
  }
  .rule input[name='path'] {
    flex: 1;
    min-width: 180px;
  }
</style>
