# Player Data Synchronization V1

Sync is separate from Files Updater. PostgreSQL owns metadata; private S3 objects contain file bytes. Existing profiles remain disabled until configured.

## Deployment

Regenerate the Prisma client with `npx prisma generate` and apply the schema through the existing deployment flow (`prisma db push`, already run by the Docker entrypoints). This adds Sync tables, including durable `SyncPathVersion` generations and `SyncObjectLease` download protection, and indexes for object-reference lookups without changing existing file data. No database operation is performed by the source-code implementation itself.

After regenerating the client or changing the schema, restart the development server (or its web container). Hot reload can retain an older Prisma instance in memory. Activity counters remain internal and are not displayed by Sync or Stats. Counter writes do not participate in file-commit transactions.

Set `SYNC_ENABLED=true` and configure storage at **Dashboard > Sync**. Alternatively supply all of `SYNC_S3_ENDPOINT`, `SYNC_S3_REGION`, `SYNC_S3_BUCKET`, `SYNC_S3_ACCESS_KEY`, `SYNC_S3_SECRET_KEY`. Saved panel configuration takes precedence. `SYNC_S3_FORCE_PATH_STYLE=true` supports endpoints requiring path-style addressing. Storage configuration is validated when used; an incomplete configuration returns 503. With Sync disabled, S3 is never required.

Other settings:

| Variable | Default |
| --- | --- |
| `SYNC_DEFAULT_PLAYER_QUOTA` | 5368709120 bytes; used until a quota is saved in the Sync dashboard |
| `SYNC_DEFAULT_MAX_FILE_SIZE` | 1073741824 bytes |
| `SYNC_SIGNED_URL_TTL` | 900 seconds |
| `SYNC_TOMBSTONE_RETENTION_DAYS` | 90 days |
| `SYNC_PLAYER_TOKEN_TTL_SECONDS` | 900 seconds |

`JWT_SECRET_KEY` must contain at least 32 bytes. Database S3 credentials use the existing `S3_ENCRYPTION_KEY`. Only staff allowed to configure Sync receive the access key ID in panel data; the secret key and player tokens are never returned. If credentials cannot be decrypted, the configuration form remains available and requires both keys again. When no key is configured, first-time creation atomically persists it in `env/.s3-encryption-key`; back up this file with `env/.env`. Decryption never creates a replacement key. The S3 account needs Head/Get/Put/DeleteObject and ListBucket for the private `players/` prefix. SHA-256 object checksums must be supported. Only temporary signed URLs are sent to the launcher.

The Sync connection check confirms bucket access only. Sync also needs `s3:GetObject` (used by `HeadObject` to check and verify uploaded files), `s3:PutObject`, `s3:DeleteObject`, and `s3:ListBucket` for the private `players/` prefix. A successful `aws s3 cp` only confirms that `PutObject` is allowed. With SSE-KMS, checksum retrieval may additionally require `kms:Decrypt` and `kms:GenerateDataKey`. Storage errors include the failed Sync operation, S3 error code, and HTTP status when available.

For direct uploads, the launcher must send every header from `uploadHeaders` returned by `upload/prepare`, including the exact `content-length` and `x-amz-checksum-sha256` values. The checksum header is part of the presigned signature.

Set the per-player quota under **Dashboard > Sync**. It applies to all of each player's profiles together; existing per-profile storage quotas are retained in the database but ignored. Lowering the quota does not delete data: uploads exceeding the new limit are rejected. Open **Profiles > selected profile > Synchronisation** (also linked from Sync), enable Sync, set the optional file-size limit and add inclusion/exclusion rules. Exclusions take precedence. Keep administrator-managed Files Updater paths out of personal Sync rules.

## HTTP protocol

All data routes require the existing player bearer token from `/api/sync/auth/handshake`, which verifies the Minecraft access token server-side. Every query is scoped to that player. For protected profiles, all profile Sync routes additionally require `X-Profile-Token: <token>`, using the profile-scoped token issued by `POST /api/profiles/{slug}/auth`; keep the player token in `Authorization: Bearer <token>`. The API supports devices, config, revision, paginated manifests, single/batch preparation, upload commit, single/batch download and tombstone deletion as specified in the source document.

Manifest pages return an object keyed by relative path and `nextCursor`. Send `revision` on subsequent pages; `409 MANIFEST_CHANGED` requires restarting. Default page size is 1000, maximum 5000. Batches accept at most 100 entries; upload batches return per-file results, so partial successful reservations remain explicit. Supply `deviceId` either per upload or on the batch body. Binary content goes directly to S3.

Existing `code` values remain compatible with the original launcher. `error` supplies the specification's `SYNC_*` aliases. Version conflicts include the expected and current versions. Upload quotas count active files plus pending reservations, with credit for replaced content, and are rechecked at commit. Writes pause during global maintenance; configuration, manifests and downloads remain readable.

`GET /api/sync/profiles/{profileId}/usage` returns the authenticated player's effective quota and its breakdown, without requiring S3:

```json
{
  "scope": "player",
  "quotaBytes": "5368709120",
  "usedBytes": "1234",
  "reservedBytes": "56",
  "profiles": [{ "profileId": "profile-id", "usedBytes": "1234", "reservedBytes": "56" }]
}
```

All byte values are decimal strings. The totals and breakdown use the same database snapshot. `usedBytes` counts all active logical files, including files hidden by current rules; `reservedBytes` counts unexpired pending upload reservations. Deleted files and expired or completed uploads are excluded. Entries with only reservations are included; an empty scope has an empty `profiles` array. The effective quota is checked against `usedBytes + reservedBytes`, and these values may change immediately after the response. The scope is always `player` and includes every profile. The endpoint requires an enabled Sync profile and a player bearer token.

## Administration and cleanup

The Sync page shows searchable players, device/file counts, logical storage and the latest synchronization time. Player details show per-profile usage and file metadata. Global activity counters and referenced physical-storage totals are not displayed; the Stats page keeps its existing launcher statistics.

`p_sync` levels follow the panel's numeric permission model: 0 none, 1 view/configure (existing access preserved), 2 view only, 3 view/configure/delete player data. Administrators can manage Sync. Private binary downloads are not exposed to staff. Player detail shows paginated file metadata and allows deletion of one profile or all synchronized data with UUID confirmation. Configuration changes and administrative deletions are audited. Changing the S3 bucket or endpoint is rejected while live files, upload sessions or active download leases exist. Administrative resets retain compact path generations, so recreated files never reuse an old version. They also retain object leases through the expiry of outstanding PUT URLs, even after sessions and devices are removed. Signed PUT URLs never outlast their upload session.

Every five minutes, each running server expires abandoned uploads, purges old tombstones with a revision bump while retaining compact per-path version generations, and scans one bounded page of the S3 prefix. Unreferenced objects are deleted only after a grace period of at least an hour and twice the URL TTL. Uploads and collection share PostgreSQL advisory locks per object. Pending uploads, live files and persisted download leases protect referenced objects until signed download URLs expire; deleting a profile also leaves its objects eligible for collection. Failed storage operations retry on subsequent intervals.

The first version deliberately keeps no historical file versions, binary diffs, format-specific merges, P2P or WebSockets. Content-addressed storage deduplicates within each player/profile scope.

## Verification

`npm run test:sync` covers authentication, player isolation, path rules, pagination revisions, device ownership, tombstones, concurrent commits, quotas/reservations and unavailable storage using simulated PostgreSQL/S3. `npm run check` validates TypeScript and Svelte. Real Minecraft identity verification and transfers against a deployed S3/PostgreSQL instance require an integration environment and valid user credentials.

## Pre-production updates

`docker/docker-compose.pprd.yml` uses port 8085 and explicitly disables the updater with `UPDATER_ENABLED=false`. Setup skips updater reload and restarts the web server normally. Automatic Settings updates are unavailable for this stack. To update, select the desired beta image tag in that Compose file, then run `docker compose -f docker/docker-compose.pprd.yml pull web` and `docker compose -f docker/docker-compose.pprd.yml up -d web` from the repository root. Production retains its updater service.
