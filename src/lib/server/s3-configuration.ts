import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ServerError } from '$lib/utils/errors'
import { NotificationCode } from '$lib/utils/notifications'

function getEncryptionKey(): Buffer {
  let rawKey = process.env.S3_ENCRYPTION_KEY

  if (!rawKey || rawKey === 'undefined') {
    const envPath = resolve(process.cwd(), 'env', '.env')

    try {
      const envContent = readFileSync(envPath, 'utf8')
      rawKey = randomBytes(32).toString('hex')
      const keyLine = `S3_ENCRYPTION_KEY="${rawKey}"`
      const updatedEnv = /^S3_ENCRYPTION_KEY=[^\r\n]*$/m.test(envContent)
        ? envContent.replace(/^S3_ENCRYPTION_KEY=[^\r\n]*$/m, keyLine)
        : `${envContent.trimEnd()}\n${keyLine}\n`

      writeFileSync(envPath, updatedEnv)
      process.env.S3_ENCRYPTION_KEY = rawKey
    } catch (err) {
      console.error('Failed to initialize the S3 encryption key:', err)
      throw new ServerError('S3 encryption key could not be initialized', err, NotificationCode.S3_ENCRYPTION_KEY_INVALID, 500)
    }
  }

  if (!/^[\da-f]{64}$/i.test(rawKey)) {
    throw new ServerError('S3 encryption key must be 32 bytes encoded as hexadecimal', undefined, NotificationCode.S3_ENCRYPTION_KEY_INVALID, 500)
  }

  return Buffer.from(rawKey, 'hex')
}

export function encryptS3Credential(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])

  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.')
}

export function decryptS3Credential(value: string): string {
  const [encodedIv, encodedTag, encodedCiphertext, ...extra] = value.split('.')
  if (!encodedIv || !encodedTag || !encodedCiphertext || extra.length > 0) {
    throw new ServerError('Stored S3 credential is malformed', undefined, NotificationCode.S3_ENCRYPTION_KEY_INVALID, 500)
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(encodedIv, 'base64url'))
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, 'base64url')), decipher.final()]).toString('utf8')
  } catch (err) {
    console.error('Failed to decrypt an S3 credential:', err)
    throw new ServerError('Stored S3 credential could not be decrypted', err, NotificationCode.S3_ENCRYPTION_KEY_INVALID, 500)
  }
}
