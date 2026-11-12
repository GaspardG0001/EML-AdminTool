<script lang="ts">
  import { enhance } from '$app/forms'
  import { formatBytes } from '$lib/utils/format-bytes'
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

<header class="page-header">
  <a href="/dashboard/sync">← Sync</a>
  <h2>Synchronisation</h2>
  <p>{data.profile.name}</p>
</header>

{#if !data.globallyEnabled}
  <p class="service-warning" role="status">Le service Sync est désactivé sur le serveur.</p>
{/if}
{#if form?.success}<p class="form-message success" role="status">Configuration enregistrée.</p>{/if}
{#if form?.message}<p class="form-message error" role="alert">{form.message}</p>{/if}

<form method="POST" use:enhance>
  <section class="section">
    <fieldset disabled={!data.canConfigure} class="settings">
      <div class="section-heading">
        <div>
          <h3>Paramètres du profil</h3>
          <p>Le quota global par joueur se règle sur la page Sync.</p>
        </div>
      </div>
      <label class="enable-setting">
        <input type="checkbox" name="enabled" checked={data.profile.syncProfile?.enabled ?? false} />
        <span>Activer la synchronisation pour ce profil</span>
      </label>
      <div class="file-limit">
        <label for="max-file-bytes">Taille maximale par fichier</label>
        <input
          id="max-file-bytes"
          name="maxFileBytes"
          inputmode="numeric"
          pattern="[0-9]*"
          value={data.profile.syncProfile?.maxFileBytes?.toString() ?? ''}
          placeholder={`Par défaut : ${formatBytes(data.defaults.maxFileBytes)}`}
        />
      </div>
      <div class="section-heading rules-heading">
        <div>
          <h3>Règles de fichiers</h3>
          <p>Les exclusions sont prioritaires. Seuls les chemins inclus sont synchronisés.</p>
        </div>
      </div>
      <div class="rules-list">
        {#each rules as rule, i}
          <div class="rule">
            <label class="rule-enabled">
              <input type="checkbox" name={`enabled-${i}`} bind:checked={rule.enabled} />
              Active
            </label>
            <input aria-label="Chemin relatif" name="path" bind:value={rule.path} maxlength="1024" placeholder="saves/**" />
            <select aria-label="Action" name="action" bind:value={rule.action}>
              <option value="INCLUDE">Inclure</option>
              <option value="EXCLUDE">Exclure</option>
            </select>
            <button type="button" class="secondary remove-rule" onclick={() => (rules = rules.filter((_, index) => index !== i))}> Supprimer </button>
          </div>
        {:else}
          <p class="empty-state">Aucune règle. Ajoutez un chemin à synchroniser.</p>
        {/each}
      </div>
      <div class="form-actions">
        <button
          type="button"
          class="secondary"
          disabled={rules.length >= 200}
          onclick={() => (rules = [...rules, { path: '', action: 'INCLUDE', enabled: true }])}>Ajouter une règle</button
        >
        <button type="submit">Enregistrer</button>
      </div>
    </fieldset>
  </section>
</form>

<style lang="scss">
  @use '../../../../../../../static/scss/dashboard.scss';

  .page-header {
    margin-bottom: 28px;

    h2 {
      margin: 14px 0 0;
    }

    p {
      margin: 4px 0 0;
      color: #707070;
    }
  }

  section.section {
    margin-top: 24px;
    padding: 28px;
  }

  .settings {
    min-width: 0;
    border: 0;
    padding: 0;
  }

  .section-heading {
    margin-bottom: 20px;

    h3 {
      margin: 0;
    }

    p {
      margin: 6px 0 0;
      color: #707070;
      font-size: 14px;
    }
  }

  .enable-setting {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 24px;
    color: var(--text-dark-color);

    input {
      flex: 0 0 auto;
      margin: 0;
    }
  }

  .file-limit {
    max-width: 440px;
    margin-bottom: 28px;

    label {
      margin: 0 0 5px;
    }

    input {
      box-sizing: border-box;
      width: 100%;
    }
  }

  .rules-heading {
    margin-bottom: 14px;
  }

  .rules-list {
    display: grid;
    gap: 10px;
  }

  .rule {
    display: grid;
    grid-template-columns: 90px minmax(180px, 1fr) minmax(130px, 180px) auto;
    align-items: center;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--border-color);
    border-radius: 6px;

    input:not([type='checkbox']) {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      margin: 0;
    }

    select {
      width: 100%;
      margin: 0;
    }

    .rule-enabled {
      display: flex;
      align-items: center;
      gap: 7px;
      margin: 0;
      color: var(--text-dark-color);

      input {
        margin: 0;
      }
    }

    .remove-rule {
      margin: 0;
      white-space: nowrap;
    }
  }

  .empty-state {
    margin: 0;
    padding: 14px 0;
    color: #707070;
  }

  .form-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 20px;

    button {
      margin: 0;
    }
  }

  .form-message,
  .service-warning {
    margin: 12px 0;
  }

  .success {
    color: var(--green-color);
  }

  .error,
  .service-warning {
    color: var(--red-color);
  }

  @media (max-width: 800px) {
    section.section {
      padding: 22px 18px;
    }

    .rule {
      grid-template-columns: 1fr 1fr;

      .rule-enabled {
        grid-column: 1 / -1;
      }

      input:not([type='checkbox']) {
        grid-column: 1 / -1;
        grid-row: 2;
      }

      .remove-rule {
        justify-self: start;
      }
    }
  }
</style>
