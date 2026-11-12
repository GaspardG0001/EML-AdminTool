# Player Data Synchronization V1

Sync is separate from Files Updater. PostgreSQL owns metadata; private S3 objects contain file bytes. Existing profiles remain disabled until configured.

## Deployment

Regenerate the Prisma client with `npx prisma generate` and apply the schema through the existing deployment flow (`prisma db push`, already run by the Docker entrypoints). This adds the `SyncMetric` table without changing existing file data. No database operation is performed by the source-code implementation itself.

After regenerating the client or changing the schema, restart the development server (or its web container). Hot reload can retain an older Prisma instance in memory. If activity counters are unavailable during an upgrade, Sync and Stats keep showing player/storage statistics with an explicit notice. Counter writes do not participate in file-commit transactions.

Set `SYNC_ENABLED=true` and configure storage at **Dashboard > Sync**. Alternatively supply all of `SYNC_S3_ENDPOINT`, `SYNC_S3_REGION`, `SYNC_S3_BUCKET`, `SYNC_S3_ACCESS_KEY`, `SYNC_S3_SECRET_KEY`. Saved panel configuration takes precedence. `SYNC_S3_FORCE_PATH_STYLE=true` supports endpoints requiring path-style addressing. Storage configuration is validated when used; an incomplete configuration returns 503. With Sync disabled, S3 is never required.

Other settings:

| Variable | Default |
| --- | --- |
| `SYNC_DEFAULT_PLAYER_QUOTA` | 5368709120 bytes |
| `SYNC_DEFAULT_MAX_FILE_SIZE` | 1073741824 bytes |
| `SYNC_SIGNED_URL_TTL` | 900 seconds |
| `SYNC_TOMBSTONE_RETENTION_DAYS` | 90 days |
| `SYNC_PLAYER_TOKEN_TTL_SECONDS` | 900 seconds |

`JWT_SECRET_KEY` must contain at least 32 bytes. Database S3 credentials use the existing `S3_ENCRYPTION_KEY`. Neither credentials nor player tokens are returned in panel data or logs. The S3 account needs Head/Get/Put/DeleteObject and ListBucket for the private `players/` prefix. SHA-256 object checksums must be supported. Only temporary signed URLs are sent to the launcher.

The Sync connection check confirms bucket access only. Sync also needs `s3:GetObject` (used by `HeadObject` to check and verify uploaded files), `s3:PutObject`, `s3:DeleteObject`, and `s3:ListBucket` for the private `players/` prefix. A successful `aws s3 cp` only confirms that `PutObject` is allowed. With SSE-KMS, checksum retrieval may additionally require `kms:Decrypt` and `kms:GenerateDataKey`. Storage errors include the failed Sync operation, S3 error code, and HTTP status when available.

For direct uploads, the launcher must send every header from `uploadHeaders` returned by `upload/prepare`, including the exact `content-length` and `x-amz-checksum-sha256` values. The checksum header is part of the presigned signature.

Open **Profiles > selected profile > Synchronisation** (also linked from Sync), enable Sync, set optional per-player limits and add inclusion/exclusion rules. Exclusions take precedence. Keep administrator-managed Files Updater paths out of personal Sync rules.

## HTTP protocol

All data routes require the existing player bearer token from `/api/sync/auth/handshake`, which verifies the Minecraft access token server-side. Every query is scoped to that player. The API supports devices, config, revision, paginated manifests, single/batch preparation, upload commit, single/batch download and tombstone deletion as specified in the source document.

Manifest pages return an object keyed by relative path and `nextCursor`. Send `revision` on subsequent pages; `409 MANIFEST_CHANGED` requires restarting. Default page size is 1000, maximum 5000. Batches accept at most 100 entries; upload batches return per-file results, so partial successful reservations remain explicit. Supply `deviceId` either per upload or on the batch body. Binary content goes directly to S3.

Existing `code` values remain compatible with the original launcher. `error` supplies the specification's `SYNC_*` aliases. Version conflicts include the expected and current versions. Upload quotas count active files plus pending reservations, with credit for replaced content, and are rechecked at commit. Writes pause during global maintenance; configuration, manifests and downloads remain readable.

## Administration and cleanup

The Sync page shows searchable players, devices, logical storage, referenced physical storage, per-profile usage and activity counters. The existing Stats page also shows Sync totals for staff with Sync access. Physical storage excludes orphaned/pending objects until collection; it is explicitly labelled as referenced storage.

`p_sync` levels follow the panel's numeric permission model: 0 none, 1 view/configure (existing access preserved), 2 view only, 3 view/configure/delete player data. Administrators can manage Sync. Private binary downloads are not exposed to staff. Player detail shows paginated file metadata and allows deletion of one profile or all synchronized data with UUID confirmation. Configuration changes and administrative deletions are audited.

Every five minutes, each running server expires abandoned uploads, purges old tombstones with a revision bump, and scans one bounded page of the S3 prefix. Unreferenced objects are deleted only after a grace period of at least an hour and twice the URL TTL. Uploads and collection share PostgreSQL advisory locks per object. Pending uploads and live files protect referenced objects; deleting a profile also leaves its objects eligible for collection. Failed storage operations retry on subsequent intervals.

The first version deliberately keeps no historical file versions, binary diffs, format-specific merges, P2P or WebSockets. Content-addressed storage deduplicates within each player/profile scope.

## Verification

`npm run test:sync` covers authentication, player isolation, path rules, pagination revisions, device ownership, tombstones, concurrent commits, quotas/reservations and unavailable storage using simulated PostgreSQL/S3. `npm run check` validates TypeScript and Svelte. Real Minecraft identity verification and transfers against a deployed S3/PostgreSQL instance require an integration environment and valid user credentials.
