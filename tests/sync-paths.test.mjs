import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateFilePath, compileSyncGlob, isSyncPathAllowed } from '../src/lib/sync/paths.ts'
import { performance } from 'node:perf_hooks'

test('portable relative paths and Windows separators', () => {
  assert.equal(validateFilePath('config\\test.toml'), 'config/test.toml')
  for (const path of ['../secret', '/etc/passwd', 'C:\\secret', 'a//b', 'a/./b', 'a:b', 'NUL.txt', 'a. /b', 'a\0b', 'a*']) {
    assert.throws(() => validateFilePath(path), path)
  }
})

test('pathological wildcards are bounded and compiled matchers are reused', () => {
  const start = performance.now()
  const glob = 'saves/*a*a*a*a*a*a*a*a*a*a*b'
  const matcher = compileSyncGlob(glob)
  assert.equal(matcher, compileSyncGlob(glob))
  assert.equal(matcher.test(`saves/${'a'.repeat(100)}`), false)
  assert.equal(compileSyncGlob('saves/**/**/**a**b').test(`saves/${'a/'.repeat(100)}c`), false)
  assert.ok(performance.now() - start < 1000)
  assert.equal(compileSyncGlob('saves/**/level.dat').test('saves/level.dat'), true)
  assert.equal(compileSyncGlob('saves/**/level.dat').test('saves/a/b/level.dat'), true)
  assert.equal(compileSyncGlob('saves/?.dat').test('saves/a.dat'), true)
  assert.equal(compileSyncGlob('saves/?.dat').test('saves/ab.dat'), false)
  for (let i = 0; i < 600; i++) compileSyncGlob(`saves/cache-${i}`)
  assert.notEqual(matcher, compileSyncGlob(glob))
})
test('explicit inclusion, exclusion precedence and recursive globs', () => {
  const rules = [
    { path: 'saves/**', action: 'INCLUDE' },
    { path: 'saves/**/session.lock', action: 'EXCLUDE' }
  ]
  assert.ok(isSyncPathAllowed('saves/world/level.dat', rules))
  assert.equal(isSyncPathAllowed('saves/session.lock', rules), false)
  assert.equal(isSyncPathAllowed('saves/world/session.lock', rules), false)
  assert.equal(isSyncPathAllowed('config/a.toml', rules), false)
  assert.equal(isSyncPathAllowed('saves/world/a', [{ ...rules[0], enabled: false }]), false)
  assert.ok(compileSyncGlob('config/*.toml').test('config/a.toml'))
  assert.equal(compileSyncGlob('config/*.toml').test('config/sub/a.toml'), false)
  assert.equal(compileSyncGlob('config/a.b').test('config/axb'), false)
})
