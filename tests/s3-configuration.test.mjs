import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ts from 'typescript'

const execute = promisify(execFile)
const inputs = await Promise.all(['src/lib/utils/notifications.ts', 'src/lib/utils/errors.ts', 'src/lib/server/s3-configuration.ts'].map((f) => readFile(f, 'utf8')))
const combined = inputs.join('\n').replace(/^import .*from ['"](?:\$lib\/|\.\/notifications)[^'"\r\n]*['"]\s*$/gm, '').replace(/^export /gm, '')
const bundled = ts.transpileModule(combined, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
// dotenv must resolve from this repository even when workers run in a fresh directory.
const workerSource = bundled.replace(/from ['"]dotenv['"]/g, `from ${JSON.stringify(new URL('../node_modules/dotenv/lib/main.js', import.meta.url).href)}`)

async function inTemporaryDirectory(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'eml-s3-key-test-'))
  try { await callback(root) }
  finally {
    const relative = path.relative(tmpdir(), root)
    assert.ok(relative.startsWith('eml-s3-key-test-') && !relative.includes(path.sep))
    await rm(root, { recursive: true, force: true })
  }
}

function worker(root, main) {
  return execute(process.execPath, ['--input-type=module', '-e', `${workerSource}\n${main}`], {
    cwd: root, env: { ...process.env, S3_ENCRYPTION_KEY: '' }
  })
}

test('concurrent workers publish one persistent S3 key and decrypt each other after restart', async () => {
  await inTemporaryDirectory(async (root) => {
    await mkdir(path.join(root, 'env'))
    await writeFile(path.join(root, 'env/.env'), 'UNRELATED_SETTING="preserved"\n')
    const results = await Promise.all(Array.from({ length: 6 }, () => worker(root, 'process.stdout.write(encryptS3Credential("test-credential"))')))
    const ciphertexts = results.map((r) => r.stdout)
    const key = await readFile(path.join(root, 'env/.s3-encryption-key'), 'utf8')
    assert.match(key, /^[a-f0-9]{64}$/)
    const restarted = await worker(root, `process.stdout.write(JSON.stringify(${JSON.stringify(ciphertexts)}.map(decryptS3Credential)))`)
    assert.deepEqual(JSON.parse(restarted.stdout), Array(6).fill('test-credential'))
    assert.equal(await readFile(path.join(root, 'env/.env'), 'utf8'), 'UNRELATED_SETTING="preserved"\n')
    assert.deepEqual((await readdir(path.join(root, 'env'))).sort(), ['.env', '.s3-encryption-key'])
  })
})

test('workers reuse an existing env key without replacing it', async () => {
  await inTemporaryDirectory(async (root) => {
    await mkdir(path.join(root, 'env'))
    const contents = `S3_ENCRYPTION_KEY="${'b'.repeat(64)}"\n`
    await writeFile(path.join(root, 'env/.env'), contents)
    const encrypted = await worker(root, 'process.stdout.write(encryptS3Credential("existing-key"))')
    const decrypted = await worker(root, `process.stdout.write(decryptS3Credential(${JSON.stringify(encrypted.stdout)}))`)
    assert.equal(decrypted.stdout, 'existing-key')
    assert.equal(await readFile(path.join(root, 'env/.env'), 'utf8'), contents)
    assert.deepEqual(await readdir(path.join(root, 'env')), ['.env'])
  })
})

test('decryption with a missing key fails without generating a replacement', async () => {
  await inTemporaryDirectory(async (root) => {
    await mkdir(path.join(root, 'env'))
    await assert.rejects(worker(root, 'decryptS3Credential("a.b.c")'))
    assert.deepEqual(await readdir(path.join(root, 'env')), [])
  })
})
