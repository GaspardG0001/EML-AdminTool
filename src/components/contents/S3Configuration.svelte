<script lang="ts">
  import { applyAction, enhance } from '$app/forms'
  import { l } from '$lib/stores/language'
  import { addNotification } from '$lib/stores/notifications'
  import type { NotificationCode } from '$lib/utils/notifications'
  import type { SubmitFunction } from '@sveltejs/kit'

  interface Props {
    configuration: {
      region: string
      bucket: string
      endpoint: string
      credentialsConfigured: boolean
    } | null
  }

  let { configuration }: Props = $props()
  let accessKeyId = $state('')
  let secretAccessKey = $state('')
  let credentialsSaved = $state(false)
  let hasCredentials = $derived(Boolean(configuration?.credentialsConfigured || credentialsSaved))
  let saving = $state(false)

  const enhanceForm: SubmitFunction = () => {
    saving = true

    return async ({ result, update }) => {
      saving = false
      await update({ reset: false, invalidateAll: false })

      if (result.type === 'failure') {
        const message = $l.notifications[result.data?.failure as NotificationCode] ?? $l.notifications.INTERNAL_SERVER_ERROR
        addNotification('ERROR', message)
      } else if (result.type === 'success') {
        credentialsSaved = true
        accessKeyId = ''
        secretAccessKey = ''
        addNotification('SUCCESS', $l.notifications.S3_CONFIGURATION_SAVED)
      }

      await applyAction(result)
    }
  }
</script>

<form method="POST" action="?/save" use:enhance={enhanceForm}>
  <div class="fields">
    <div>
      <label for="s3-region">{$l.dashboard.s3Configuration.region}</label>
      <input
        id="s3-region"
        name="region"
        type="text"
        value={configuration?.region ?? ''}
        placeholder="eu-west-1"
        required
        maxlength="128"
      />
    </div>

    <div>
      <label for="s3-access-key-id">{$l.dashboard.s3Configuration.accessKeyId}</label>
      <input
        id="s3-access-key-id"
        name="accessKeyId"
        type="text"
        bind:value={accessKeyId}
        placeholder={hasCredentials ? '••••••••' : ''}
        autocomplete="off"
        required={!hasCredentials}
        maxlength="256"
      />
    </div>

    <div>
      <label for="s3-secret-access-key">{$l.dashboard.s3Configuration.secretAccessKey}</label>
      <input
        id="s3-secret-access-key"
        name="secretAccessKey"
        type="password"
        bind:value={secretAccessKey}
        placeholder={hasCredentials
          ? $l.dashboard.s3Configuration.secretPlaceholder
          : $l.dashboard.s3Configuration.requiredSecretPlaceholder}
        autocomplete="new-password"
        required={!hasCredentials}
        maxlength="4096"
      />
    </div>

    <div>
      <label for="s3-bucket">{$l.dashboard.s3Configuration.bucket}</label>
      <input id="s3-bucket" name="bucket" type="text" value={configuration?.bucket ?? ''} required maxlength="255" />
    </div>

    <div class="endpoint">
      <label for="s3-endpoint">{$l.dashboard.s3Configuration.endpoint}</label>
      <input
        id="s3-endpoint"
        name="endpoint"
        type="url"
        value={configuration?.endpoint ?? ''}
        placeholder={$l.dashboard.s3Configuration.endpointPlaceholder}
        required
        maxlength="2048"
      />
    </div>
  </div>

  {#if hasCredentials}
    <p class="saved-note" aria-live="polite">{$l.dashboard.s3Configuration.saved}</p>
  {/if}

  <button class="primary" type="submit" disabled={saving}>
    {saving ? $l.dashboard.s3Configuration.saving : $l.dashboard.s3Configuration.save}
  </button>
</form>

<style lang="scss">
  form {
    .fields {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0 24px;

      label {
        margin-top: 18px;
      }
    }

    .endpoint {
      grid-column: 1 / -1;
    }

    .saved-note {
      color: #666;
      font-size: 13px;
      margin-bottom: 0;
    }
  }

  @media (max-width: 700px) {
    form .fields {
      grid-template-columns: 1fr;

      .endpoint {
        grid-column: auto;
      }
    }
  }
</style>
