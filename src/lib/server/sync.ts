import { recordSyncMetric } from './sync-metrics'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { errors, jwtVerify, SignJWT } from 'jose'
import { createHash, randomUUID } from 'node:crypto'
import { db } from '$lib/server/db'
import { decryptS3Credential } from '$lib/server/s3-configuration'
import { getBearerToken, readLimitedText } from '$lib/server/request'
import { BusinessError } from '$lib/utils/errors'
import type { Player } from '@prisma/client'
import { validateFilePath, isSyncPathAllowed } from '$lib/sync/paths'
import { syncActionLimiter } from './limiter'
export { isSyncPathAllowed }

const DEFAULT_PLAYER_QUOTA = 5n * 1024n * 1024n * 1024n
const DEFAULT_MAX_FILE_SIZE = 1024n * 1024n * 1024n
const DEFAULT_SIGNED_URL_TTL = 900
const MAX_SIGNED_URL_TTL = 604800

export class SyncApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'SyncApiError'
  }
}

export interface SyncStorage {
  client: S3Client
  bucket: string
  signedUrlTtl: number
}

export interface SyncRuntimeConfig {
  defaultPlayerQuota: bigint
  defaultMaxFileSize: bigint
  signedUrlTtl: number
}

export interface UploadRequest {
  path: string
  hash: string
  size: bigint
  baseVersion: number | null
  deviceId: string
}

export interface SyncHandshakeRequest {
  accessToken: string
  deviceId: string
  deviceName: string
  platform: string
  arch: string | null
  launcherVersion: string | null
}

export interface VerifiedMinecraftProfile {
  uuid: string
  name: string
}

let cachedStorage: { cacheKey: string; storage: SyncStorage } | undefined

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET_KEY
  if (!secret || secret === 'undefined') {
    throw new SyncApiError('Player authentication is not configured', 'SYNC_AUTH_NOT_CONFIGURED', 503)
  }
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new SyncApiError('JWT_SECRET_KEY must contain at least 32 bytes', 'SYNC_AUTH_NOT_CONFIGURED', 503)
  }
  return new TextEncoder().encode(secret)
}

export function assertSyncAuthConfigured(): void {
  getJwtSecret()
}

function getPlayerTokenTtlSeconds(): number {
  const raw = process.env.SYNC_PLAYER_TOKEN_TTL_SECONDS
  if (!raw) return 900

  const ttl = Number(raw)
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
    throw new SyncApiError('SYNC_PLAYER_TOKEN_TTL_SECONDS must be between 60 and 3600', 'SYNC_CONFIGURATION_INVALID', 500)
  }
  return ttl
}

export async function createSyncPlayerToken(playerId: string): Promise<{ token: string; expiresAt: Date }> {
  const issuedAt = Math.floor(Date.now() / 1000)
  const ttlSeconds = getPlayerTokenTtlSeconds()
  const token = await new SignJWT({ scope: 'sync-player', playerId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setJti(randomUUID())
    .setIssuer('eml-admintool')
    .setAudience('eml-sync')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(getJwtSecret())

  return { token, expiresAt: new Date((issuedAt + ttlSeconds) * 1000) }
}

export function parseSyncHandshakeRequest(input: unknown): SyncHandshakeRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SyncApiError('Request body must be an object', 'INVALID_REQUEST', 400)
  }

  const body = input as Record<string, unknown>
  if (Object.keys(body).some((key) => !['accessToken', 'deviceId', 'deviceName', 'platform', 'arch', 'launcherVersion'].includes(key))) {
    throw new SyncApiError('Request body contains unsupported fields', 'INVALID_REQUEST', 400)
  }
  if (
    typeof body.accessToken !== 'string' ||
    body.accessToken.length < 16 ||
    body.accessToken.length > 8192 ||
    /[\u0000-\u001f\u007f]/.test(body.accessToken)
  ) {
    throw new SyncApiError('A valid Minecraft access token is required', 'INVALID_ACCESS_TOKEN', 400)
  }
  if (typeof body.deviceId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(body.deviceId)) {
    throw new SyncApiError('deviceId must be a stable UUID', 'INVALID_DEVICE', 400)
  }
  if (typeof body.deviceName !== 'string' || !body.deviceName.trim() || body.deviceName.trim().length > 64) {
    throw new SyncApiError('deviceName must be between 1 and 64 characters', 'INVALID_DEVICE', 400)
  }
  if (typeof body.platform !== 'string' || !['win32', 'darwin', 'linux'].includes(body.platform)) {
    throw new SyncApiError('platform is not supported', 'INVALID_DEVICE', 400)
  }
  if (body.arch !== undefined && body.arch !== null && (typeof body.arch !== 'string' || !/^[\w-]{1,32}$/.test(body.arch))) {
    throw new SyncApiError('arch is invalid', 'INVALID_DEVICE', 400)
  }
  if (
    body.launcherVersion !== undefined &&
    body.launcherVersion !== null &&
    (typeof body.launcherVersion !== 'string' || !/^[\w.+-]{1,64}$/.test(body.launcherVersion))
  ) {
    throw new SyncApiError('launcherVersion is invalid', 'INVALID_DEVICE', 400)
  }

  return {
    accessToken: body.accessToken,
    deviceId: body.deviceId.toLowerCase(),
    deviceName: body.deviceName.trim(),
    platform: body.platform,
    arch: typeof body.arch === 'string' ? body.arch : null,
    launcherVersion: typeof body.launcherVersion === 'string' ? body.launcherVersion : null
  }
}

export async function verifyMinecraftAccessToken(accessToken: string): Promise<VerifiedMinecraftProfile> {
  let response: Response
  try {
    response = await fetch('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    })
  } catch {
    throw new SyncApiError('Minecraft identity provider is unavailable', 'IDENTITY_PROVIDER_UNAVAILABLE', 503)
  }

  if (response.status === 401 || response.status === 403) {
    throw new SyncApiError('Minecraft access token is invalid or expired', 'INVALID_ACCESS_TOKEN', 401)
  }
  if (response.status === 404) {
    throw new SyncApiError('The Microsoft account has no Minecraft Java profile', 'MINECRAFT_PROFILE_REQUIRED', 403)
  }
  if (!response.ok) {
    console.error(`Minecraft identity verification failed with HTTP ${response.status}`)
    throw new SyncApiError('Minecraft identity provider could not verify the account', 'IDENTITY_PROVIDER_UNAVAILABLE', 503)
  }

  let profile: unknown
  try {
    profile = await response.json()
  } catch {
    throw new SyncApiError('Minecraft identity provider returned an invalid response', 'IDENTITY_PROVIDER_INVALID_RESPONSE', 502)
  }

  if (!profile || typeof profile !== 'object') {
    throw new SyncApiError('Minecraft identity provider returned an invalid response', 'IDENTITY_PROVIDER_INVALID_RESPONSE', 502)
  }
  const result = profile as { id?: unknown; name?: unknown }
  if (
    typeof result.id !== 'string' ||
    !/^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.test(result.id) ||
    typeof result.name !== 'string' ||
    !result.name.trim() ||
    result.name.length > 64
  ) {
    throw new SyncApiError('Minecraft identity provider returned an invalid profile', 'IDENTITY_PROVIDER_INVALID_RESPONSE', 502)
  }

  return { uuid: result.id.replace(/-/g, '').toLowerCase(), name: result.name }
}

export async function authenticateSyncPlayer(request: Request): Promise<Player> {
  const token = getBearerToken(request)
  if (!token) throw new SyncApiError('A player bearer token is required', 'UNAUTHORIZED', 401)

  let payload
  try {
    payload = (await jwtVerify(token, getJwtSecret(), { audience: 'eml-sync', issuer: 'eml-admintool', algorithms: ['HS256'] })).payload
  } catch (err) {
    if (
      err instanceof errors.JWTExpired ||
      err instanceof errors.JWTInvalid ||
      err instanceof errors.JWTClaimValidationFailed ||
      err instanceof errors.JWSInvalid ||
      err instanceof errors.JOSEAlgNotAllowed ||
      err instanceof errors.JWSSignatureVerificationFailed
    ) {
      throw new SyncApiError('Player token is invalid or expired', 'UNAUTHORIZED', 401)
    }
    throw err
  }

  if (payload.scope !== 'sync-player' || typeof payload.playerId !== 'string' || !payload.playerId) {
    throw new SyncApiError('Player token has an invalid scope', 'UNAUTHORIZED', 401)
  }

  const player = await db.player.findUnique({ where: { id: payload.playerId } })
  if (!player) throw new SyncApiError('Player identity was not found', 'UNAUTHORIZED', 401)
  if (!syncActionLimiter.canPerformAction(player.id)) throw new SyncApiError('Too many sync requests', 'TOO_MANY_REQUESTS', 429)
  return player
}

export async function readSyncJson(request: Request): Promise<unknown> {
  let text: string
  try {
    text = await readLimitedText(request, 512 * 1024)
  } catch (err) {
    if (err instanceof BusinessError) {
      throw new SyncApiError(err.message, String(err.code), err.httpStatus)
    }
    throw err
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new SyncApiError('Request body must be valid JSON', 'INVALID_REQUEST', 400)
  }
}

export function syncErrorResponse(err: unknown): Response {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'P2034') {
    return syncErrorResponse(new SyncApiError('Concurrent update; retry synchronization', 'VERSION_CONFLICT', 409))
  }
  if (err instanceof SyncApiError) {
    void recordSyncMetric(err.code === 'VERSION_CONFLICT' ? 'conflicts' : err.code === 'QUOTA_EXCEEDED' ? 'quota_exceeded' : 'request_failures')
    const aliases: Record<string, string> = { VERSION_CONFLICT: 'SYNC_CONFLICT', PATH_NOT_ALLOWED: 'SYNC_RULE_NOT_ALLOWED', INVALID_PATH: 'SYNC_INVALID_PATH', FILE_TOO_LARGE: 'SYNC_FILE_TOO_LARGE', QUOTA_EXCEEDED: 'SYNC_QUOTA_EXCEEDED', DEVICE_NOT_FOUND: 'SYNC_INVALID_DEVICE', UPLOAD_NOT_FOUND: 'SYNC_UPLOAD_NOT_FOUND', UPLOAD_EXPIRED: 'SYNC_UPLOAD_EXPIRED', UNAUTHORIZED: 'SYNC_UNAUTHORIZED' }
    return Response.json({ success: false, code: err.code, error: aliases[err.code] ?? err.code, message: err.message, ...err.details }, { status: err.status })
  }

  if (err instanceof BusinessError) {
    return Response.json({ success: false, code: err.code, message: err.message }, { status: err.httpStatus })
  }

  void recordSyncMetric('request_failures')
  // SDK errors can contain signed URLs or request headers.
  console.error('Unexpected Sync API error', err instanceof Error ? err.name : 'unknown')
  return Response.json({ success: false, code: 'INTERNAL_SERVER_ERROR', message: 'Sync request failed' }, { status: 500 })
}

export function assertSyncEnabled(): void {
  if (process.env.SYNC_ENABLED !== 'true') {
    throw new SyncApiError('Player synchronization is disabled', 'SYNC_DISABLED', 503)
  }
}

function readNonNegativeBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name]
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new SyncApiError(`${name} must be a non-negative integer`, 'SYNC_CONFIGURATION_INVALID', 500)

  try {
    return BigInt(raw)
  } catch {
    throw new SyncApiError(`${name} is invalid`, 'SYNC_CONFIGURATION_INVALID', 500)
  }
}

function readSignedUrlTtl(): number {
  const raw = process.env.SYNC_SIGNED_URL_TTL
  if (!raw) return DEFAULT_SIGNED_URL_TTL
  const ttl = Number(raw)
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_SIGNED_URL_TTL) {
    throw new SyncApiError(`SYNC_SIGNED_URL_TTL must be an integer between 1 and ${MAX_SIGNED_URL_TTL}`, 'SYNC_CONFIGURATION_INVALID', 500)
  }
  return ttl
}

export function getSyncRuntimeConfig(): SyncRuntimeConfig {
  return {
    defaultPlayerQuota: readNonNegativeBigInt('SYNC_DEFAULT_PLAYER_QUOTA', DEFAULT_PLAYER_QUOTA),
    defaultMaxFileSize: readNonNegativeBigInt('SYNC_DEFAULT_MAX_FILE_SIZE', DEFAULT_MAX_FILE_SIZE),
    signedUrlTtl: readSignedUrlTtl()
  }
}

export async function getSyncStorage(): Promise<SyncStorage> {
  const storedConfiguration = await db.s3Configuration.findUnique({ where: { id: '1' } })
  const configuration = storedConfiguration ?? (process.env.SYNC_S3_ENDPOINT && process.env.SYNC_S3_REGION && process.env.SYNC_S3_BUCKET && process.env.SYNC_S3_ACCESS_KEY && process.env.SYNC_S3_SECRET_KEY ? { endpoint: process.env.SYNC_S3_ENDPOINT, region: process.env.SYNC_S3_REGION, bucket: process.env.SYNC_S3_BUCKET, updatedAt: new Date(0), accessKeyIdEncrypted: '', secretAccessKeyEncrypted: '' } : null)
  if (!configuration) throw new SyncApiError('S3 storage has not been configured', 'SYNC_STORAGE_NOT_CONFIGURED', 503)

  let endpoint: URL
  try {
    endpoint = new URL(configuration.endpoint)
  } catch {
    throw new SyncApiError('Configured S3 endpoint is invalid', 'SYNC_STORAGE_CONFIGURATION_INVALID', 500)
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new SyncApiError('Configured S3 endpoint is invalid', 'SYNC_STORAGE_CONFIGURATION_INVALID', 500)
  }

  const forcePathStyleRaw = process.env.SYNC_S3_FORCE_PATH_STYLE
  if (forcePathStyleRaw && !['true', 'false'].includes(forcePathStyleRaw)) {
    throw new SyncApiError('SYNC_S3_FORCE_PATH_STYLE must be true or false', 'SYNC_CONFIGURATION_INVALID', 500)
  }

  const runtimeConfig = getSyncRuntimeConfig()
  const cacheKey = createHash('sha256')
    .update(
      [
        configuration.updatedAt.toISOString(),
        storedConfiguration ? '' : process.env.SYNC_S3_ACCESS_KEY ?? '',
        storedConfiguration ? '' : process.env.SYNC_S3_SECRET_KEY ?? '',
        configuration.endpoint,
        configuration.region,
        configuration.bucket,
        forcePathStyleRaw ?? 'false',
        runtimeConfig.signedUrlTtl
      ].join('\n')
    )
    .digest('hex')
  if (cachedStorage?.cacheKey === cacheKey) return cachedStorage.storage

  const client = new S3Client({
    region: configuration.region,
    endpoint: configuration.endpoint,
    forcePathStyle: forcePathStyleRaw === 'true',
    credentials: {
      accessKeyId: storedConfiguration ? decryptS3Credential(storedConfiguration.accessKeyIdEncrypted) : process.env.SYNC_S3_ACCESS_KEY!,
      secretAccessKey: storedConfiguration ? decryptS3Credential(storedConfiguration.secretAccessKeyEncrypted) : process.env.SYNC_S3_SECRET_KEY!
    }
  })
  const storage = {
    client,
    bucket: configuration.bucket,
    signedUrlTtl: runtimeConfig.signedUrlTtl
  }
  cachedStorage?.storage.client.destroy()
  cachedStorage = { cacheKey, storage }
  return storage
}

export function normalizeSyncPath(input: unknown): string {
  try { return validateFilePath(input) }
  catch { throw new SyncApiError('File path is invalid', 'INVALID_PATH', 400) }
}

export function parseUploadRequest(input: unknown): UploadRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SyncApiError('Request body must be an object', 'INVALID_REQUEST', 400)
  }
  const body = input as Record<string, unknown>
  const path = normalizeSyncPath(body.path)
  if (typeof body.hash !== 'string' || !/^sha256:[\da-f]{64}$/i.test(body.hash)) {
    throw new SyncApiError('hash must be a SHA-256 digest', 'INVALID_HASH', 400)
  }
  if (typeof body.size !== 'string' || !/^\d+$/.test(body.size)) {
    throw new SyncApiError('size must be a non-negative integer string', 'INVALID_SIZE', 400)
  }

  const size = BigInt(body.size)
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new SyncApiError('File is too large', 'FILE_TOO_LARGE', 413)

  const baseVersion = body.baseVersion
  if (baseVersion !== null && (typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 1)) {
    throw new SyncApiError('baseVersion must be a non-negative integer or null', 'INVALID_VERSION', 400)
  }
  if (typeof body.deviceId !== 'string' || !body.deviceId || body.deviceId.length > 128) {
    throw new SyncApiError('deviceId is required', 'INVALID_DEVICE', 400)
  }

  return {
    path,
    hash: body.hash.toLowerCase(),
    size,
    baseVersion,
    deviceId: body.deviceId
  }
}

export function toS3Checksum(hash: string): string {
  return Buffer.from(hash.slice('sha256:'.length), 'hex').toString('base64')
}

export function makeObjectKey(playerId: string, profileId: string, hash: string): string {
  return `players/${playerId}/profiles/${profileId}/sha256/${hash.slice('sha256:'.length)}`
}

export function isMissingS3Object(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const candidate = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return candidate.$metadata?.httpStatusCode === 404 || candidate.name === 'NotFound' || candidate.name === 'NoSuchKey'
}

function storageRequestError(err: unknown, operation: string): SyncApiError {
  const candidate =
    err && typeof err === 'object'
      ? (err as { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } })
      : {}
  const rawCode = candidate.Code ?? candidate.code ?? candidate.name
  const errorCode = typeof rawCode === 'string' && /^[\da-z._-]{1,64}$/i.test(rawCode) ? rawCode : 'UnknownError'
  const status = candidate.$metadata?.httpStatusCode
  const httpStatusCode = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
  const statusText = httpStatusCode ? `, HTTP ${httpStatusCode}` : ''

  return new SyncApiError(`Object storage is unavailable during ${operation} (${errorCode}${statusText})`, 'SYNC_STORAGE_ERROR', 503, {
    operation,
    storageError: errorCode,
    ...(httpStatusCode ? { httpStatusCode } : {})
  })
}

export async function objectExistsWithChecksum(storage: SyncStorage, key: string, expectedSize: bigint, expectedHash: string): Promise<boolean> {
  let head
  try {
    head = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key, ChecksumMode: 'ENABLED' }))
  } catch (err) {
    if (isMissingS3Object(err)) return false
    void recordSyncMetric('storage_failures')
    throw storageRequestError(err, 'upload preflight')
  }

  if (head.ChecksumSHA256 === undefined || head.ContentLength === undefined) return false
  return BigInt(head.ContentLength) === expectedSize && head.ChecksumSHA256 === toS3Checksum(expectedHash)
}

export async function signUploadUrl(storage: SyncStorage, key: string, hash: string, size: bigint): Promise<string> {
  return getSignedUrl(
    storage.client,
    new PutObjectCommand({
      Bucket: storage.bucket,
      Key: key,
      ChecksumSHA256: toS3Checksum(hash),
      ContentLength: Number(size)
    }),
    {
      expiresIn: storage.signedUrlTtl,
      unhoistableHeaders: new Set(['x-amz-checksum-sha256'])
    }
  )
}

export async function signDownloadUrl(storage: SyncStorage, key: string): Promise<string> {
  return getSignedUrl(storage.client, new GetObjectCommand({ Bucket: storage.bucket, Key: key }), { expiresIn: storage.signedUrlTtl })
}

export async function listSyncObjects(storage: SyncStorage, cursor?: string) {
  const page = await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: 'players/', MaxKeys: 1000, ContinuationToken: cursor }))
  return {
    objects: (page.Contents ?? []).map((object) => ({ key: object.Key, lastModified: object.LastModified })),
    nextCursor: page.IsTruncated ? page.NextContinuationToken : undefined
  }
}

export async function deleteSyncObject(storage: SyncStorage, key: string): Promise<void> {
  await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }))
}

export async function verifyUploadedObject(storage: SyncStorage, key: string, size: bigint, hash: string): Promise<void> {
  let head
  try {
    head = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key, ChecksumMode: 'ENABLED' }))
  } catch (err) {
    if (isMissingS3Object(err)) throw new SyncApiError('Uploaded object was not found', 'UPLOAD_OBJECT_MISSING', 409)
    void recordSyncMetric('storage_failures')
    throw storageRequestError(err, 'upload verification')
  }

  if (head.ContentLength === undefined || BigInt(head.ContentLength) !== size) {
    throw new SyncApiError('Uploaded object size does not match the request', 'UPLOAD_SIZE_MISMATCH', 400)
  }
  if (head.ChecksumSHA256 === undefined) {
    throw new SyncApiError('S3 storage must return SHA-256 checksums for uploaded objects', 'UPLOAD_CHECKSUM_UNAVAILABLE', 422)
  }
  if (head.ChecksumSHA256 !== toS3Checksum(hash)) {
    throw new SyncApiError('Uploaded object checksum does not match the request', 'UPLOAD_CHECKSUM_MISMATCH', 400)
  }
}

export async function getSyncProfile(profileId: string) {
  const syncProfile = await db.syncProfile.findUnique({
    where: { profileId },
    include: { profile: true, rules: true }
  })
  if (!syncProfile) throw new SyncApiError('Sync is not configured for this profile', 'SYNC_PROFILE_NOT_FOUND', 404)
  if (!syncProfile.enabled) throw new SyncApiError('Sync is disabled for this profile', 'SYNC_DISABLED', 403)
  return syncProfile
}
