import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateFilePath, globToRegExp, isSyncPathAllowed } from '../src/lib/sync/paths.ts'

test('portable relative paths and Windows separators', () => {
  assert.equal(validateFilePath('config\\test.toml'), 'config/test.toml')
  for (const path of ['../secret', '/etc/passwd', 'C:\\secret', 'a//b', 'a/./b', 'a:b', 'NUL.txt', 'a. /b', 'a\0b', 'a*']) {
    assert.throws(() => validateFilePath(path), path)
  }
})
test('explicit inclusion, exclusion precedence and recursive globs', () => {
  const rules = [{ path: 'saves/**', action: 'INCLUDE' }, { path: 'saves/**/session.lock', action: 'EXCLUDE' }]
  assert.ok(isSyncPathAllowed('saves/world/level.dat', rules))
  assert.equal(isSyncPathAllowed('saves/session.lock', rules), false)
  assert.equal(isSyncPathAllowed('saves/world/session.lock', rules), false)
  assert.equal(isSyncPathAllowed('config/a.toml', rules), false)
  assert.equal(isSyncPathAllowed('saves/world/a', [{ ...rules[0], enabled: false }]), false)
  assert.ok(globToRegExp('config/*.toml').test('config/a.toml'))
  assert.equal(globToRegExp('config/*.toml').test('config/sub/a.toml'), false)
  assert.equal(globToRegExp('config/a.b').test('config/axb'), false)
})
