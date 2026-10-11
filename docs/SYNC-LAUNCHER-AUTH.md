# Player Sync authentication: launcher integration

This document describes how the Electron launcher obtains and uses a Player Sync bearer token. The API contract is implemented in EML-AdminTool; launcher changes are not included in this repository.

## Existing launcher authentication

The `feature/flowblock_mc-sync` launcher uses `MicrosoftAuth` from `eml-lib` in Electron's main process. Its `Account` contains `accessToken`, `uuid`, `name` and `meta.type`; `MicrosoftAuth.validate()` checks the access token with `GET https://api.minecraftservices.com/minecraft/profile`.

Player Sync uses that same Minecraft access token as a short-lived proof. The AdminTool independently validates it with Minecraft Services. It does **not** trust the account UUID or name sent by the launcher. This proof is intended for Microsoft Java accounts (`meta.type === "msa"`); offline, Azuriom and Yggdrasil accounts do not have a compatible proof in the current launcher flow and cannot authenticate to this API.

References:

- [Launcher `electron/handlers/auth.ts`](https://github.com/GaspardG0001/NewFlowBlock_mcLauncher/blob/feature/flowblock_mc-sync/electron/handlers/auth.ts)
- [Launcher `electron/handlers/sync.ts`](https://github.com/GaspardG0001/NewFlowBlock_mcLauncher/blob/feature/flowblock_mc-sync/electron/handlers/sync.ts)
- [EML-Lib `Account` type](https://github.com/Electron-Minecraft-Launcher/EML-Lib/blob/main/types/account.d.ts)
- [EML-Lib Microsoft authentication](https://github.com/Electron-Minecraft-Launcher/EML-Lib/blob/main/lib/auth/microsoft.ts)

## Handshake

When a signed-in player enables Sync, the launcher main process sends:

```http
POST /api/sync/auth/handshake
Content-Type: application/json
```

```json
{
  "accessToken": "<Microsoft/Minecraft access token from Account>",
  "deviceId": "stable-installation-uuid",
  "deviceName": "Desktop",
  "platform": "win32",
  "arch": "x64",
  "launcherVersion": "1.4.0-beta"
}
```

`deviceId` is generated once per launcher installation and stored under Electron's `app.getPath("userData")`. Do not derive it from a hardware identifier. `deviceName` should be a user-friendly label and should not contain a hostname unless the player explicitly opts in. `platform` is Node's `process.platform` (`win32`, `darwin` or `linux`); `arch` is `os.arch()`.

Do not send `uuid`, `name`, `refreshToken`, `clientToken`, or `userProperties`. The server gets the authoritative player UUID and name by validating `accessToken` with `api.minecraftservices.com/minecraft/profile`.

Successful response:

```json
{
  "success": true,
  "token": "<short-lived signed JWT>",
  "tokenType": "Bearer",
  "expiresAt": "2026-10-11T16:00:00.000Z",
  "player": {
    "minecraftUuid": "0123456789abcdef0123456789abcdef",
    "minecraftName": "PlayerName"
  },
  "deviceId": "stable-installation-uuid"
}
```

The player UUID in this response is lowercase hexadecimal without hyphens. The token is signed by the AdminTool and has issuer `eml-admintool`, audience `eml-sync`, scope `sync-player`, a `playerId` claim, and an expiration (15 minutes by default; configurable by the server). The launcher treats the token as opaque.

## Main-process integration

Keep the Microsoft access token and Sync bearer token in Electron's main process. The existing launcher returns its full `Account` through auth IPC; when adding Sync, do not add another renderer IPC that returns tokens. Add the handshake call to the existing main-process auth/sync flow, or expose an IPC operation that takes no credentials and reads/refreshes the saved account in the main process.

Generate and persist the device identifier once:

```ts
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const deviceIdPath = path.join(app.getPath('userData'), 'sync-device-id')
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

export function getSyncDeviceId(): string {
  try {
    const stored = fs.readFileSync(deviceIdPath, 'utf8').trim()
    if (!UUID_PATTERN.test(stored)) throw new Error('Stored Sync device ID is invalid; remove sync-device-id to regenerate it.')
    return stored.toLowerCase()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    const id = randomUUID()
    fs.writeFileSync(deviceIdPath, id, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return id
  }
}
```

In the main-process sync service, exchange the current `Account.accessToken` for the AdminTool token:

```ts
import os from 'node:os'
import type { Account } from 'eml-lib'
import { app } from 'electron'
import { ADMINTOOL_URL } from '../const'
import { getSyncDeviceId } from './device-id'

interface SyncAuthResponse {
  success: true
  token: string
  expiresAt: string
  player: { minecraftUuid: string; minecraftName: string }
  deviceId: string
}

let syncToken: string | undefined
let syncTokenExpiresAt = 0

export async function authenticateSync(account: Account): Promise<SyncAuthResponse> {
  if (account.meta?.type !== 'msa' || !account.meta.online) {
    throw new Error('Player Sync requires a valid Microsoft online account.')
  }

  const response = await fetch(new URL('/api/sync/auth/handshake', ADMINTOOL_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accessToken: account.accessToken,
      deviceId: getSyncDeviceId(),
      deviceName: 'Desktop',
      platform: process.platform,
      arch: os.arch(),
      launcherVersion: app.getVersion()
    }),
    signal: AbortSignal.timeout(10_000)
  })

  const body: unknown = await response.json()
  if (!response.ok || !body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string') {
    const code = body && typeof body === 'object' && 'code' in body ? String(body.code) : `HTTP_${response.status}`
    throw new Error(`Player Sync authentication failed (${code}).`)
  }

  const result = body as SyncAuthResponse
  syncToken = result.token
  syncTokenExpiresAt = Date.parse(result.expiresAt)
  return result
}
```

Keep the actual implementation's response validation strict (including validating `expiresAt`) and do not log the request body, access token, or bearer token. Only return non-secret status and player metadata to the renderer.

The example uses in-memory token state deliberately. On launcher restart, authenticate again using the current account access token; do not persist the Sync JWT or duplicate Microsoft credentials. When the Sync JWT is near expiry, repeat the handshake. If Minecraft Services rejects an expired access token, use the existing `MicrosoftAuth.refresh(account)` flow in the main process and retry the handshake once with the refreshed account.

## Calling the upload API

Send the AdminTool token only to the AdminTool API:

```http
Authorization: Bearer <Sync JWT>
```

Use it for `POST /api/sync/profiles/:profileId/upload/prepare` and `POST /api/sync/profiles/:profileId/upload/:uploadId/commit`. The `deviceId` in the prepare body must be the same stable ID used during the handshake. The object-storage `uploadUrl` is separate: PUT file bytes directly to that URL and do not send the Sync JWT to object storage.

Never reuse the existing profile-scoped token as a Player Sync token. It establishes profile access, not the identity of the Microsoft player.

## Errors and server setup

| HTTP          | Meaning                                                | Launcher handling                                                                         |
| ------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `400`         | Malformed body, device metadata, or access token field | Fix request construction; do not retry unchanged                                          |
| `401`         | Minecraft access token invalid/expired                 | Refresh the Microsoft account once, then retry; otherwise ask the player to sign in again |
| `403`         | No Minecraft Java profile                              | Explain that a Microsoft account with Minecraft Java access is required                   |
| `429`         | Handshake rate limit reached                           | Back off; do not loop or retry immediately                                                |
| `502` / `503` | Identity provider or Sync service unavailable/disabled | Show Sync temporarily unavailable and retry later                                         |
| `409`         | Transient database conflict                            | Retry once with backoff                                                                   |

The server must set `SYNC_ENABLED=true`, configure `JWT_SECRET_KEY` (at least 32 bytes; normally generated by AdminTool setup), and provision an enabled Sync profile with include rules. The handshake limiter is currently in-memory and per application process; deployments with multiple instances should use a shared rate-limit store or enforce an equivalent limit at the reverse proxy.

## Local verification

1. Sign in with a Microsoft account using the existing launcher flow.
2. Enable Sync and invoke the handshake from the Electron main process.
3. Confirm the returned `minecraftUuid` matches the authenticated profile and that no client-submitted UUID was used.
4. Confirm the database has one `Player` and one device for the installation; restart and authenticate again to check that the same device is updated, not duplicated.
5. Test invalid/expired access tokens, offline accounts, missing Minecraft profiles, rate limiting and provider/network outage. Ensure logs contain no access or bearer tokens.
