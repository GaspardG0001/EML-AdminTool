import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import { ServerError } from '$lib/utils/errors'
import { NotificationCode } from '$lib/utils/notifications'

export function getS3EncryptionKey(create = true): string {
  let rawKey = process.env.S3_ENCRYPTION_KEY
  if (!rawKey || rawKey === 'undefined') {
    try {
      const directory = resolve(process.cwd(), 'env')
      try { rawKey = parse(readFileSync(resolve(directory, '.env'))).S3_ENCRYPTION_KEY }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
      if (!rawKey || rawKey === 'undefined') {
        const keyPath = resolve(directory, '.s3-encryption-key')
        try { rawKey = readFileSync(keyPath, 'utf8').trim() }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw err
          mkdirSync(directory, { recursive: true })
          const temporary = resolve(directory, `.s3-key-${randomBytes(16).toString('hex')}`)
          // Publish a complete file atomically, without replacing another worker's key.
          writeFileSync(temporary, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
          try {
            try { linkSync(temporary, keyPath) }
            catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }
          } finally { unlinkSync(temporary) }
          rawKey = readFileSync(keyPath, 'utf8').trim()
        }
      }
      process.env.S3_ENCRYPTION_KEY = rawKey
    } catch (err) {
      console.error('Failed to initialize the S3 encryption key:', err)
      throw new ServerError('S3 encryption key could not be initialized', err, NotificationCode.S3_ENCRYPTION_KEY_INVALID, 500)
    }
  }

  if (!/^[\da-f]{64}$/i.test(rawKey)) {
    throw new ServerError('S3 encryption key must be 32 bytes encoded as hexadecimal', undefined, NotificationCode.S3_ENCRYPTION_KEY_INVALID, 500)
  }

  return rawKey
}

export function encryptS3Credential(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(getS3EncryptionKey(), 'hex'), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])

  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.')
}

export function decryptS3Credential(value: string): string {
  const [encodedIv, encodedTag, encodedCiphertext, ...extra] = value.split('.')
  if (!encodedIv || !encodedTag || !encodedCiphertext || extra.length > 0) {
    throw new ServerError('Stored S3 credential is malformed', undefined, NotificationCode.S3_ENCRYPTION_KEY_INVALID, 500)
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(getS3EncryptionKey(false), 'hex'), Buffer.from(encodedIv, 'base64url'))
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, 'base64url')), decipher.final()]).toString('utf8')
  } catch (err) {
    console.error('Failed to decrypt an S3 credential:', err)
    throw new ServerError('Stored S3 credential could not be decrypted', err, NotificationCode.S3_ENCRYPTION_KEY_INVALID, 500)
  }
}
