export type SyncRule = { path: string; action: string; enabled?: boolean }

// Portable paths: also reject Windows aliases, streams and reserved devices.
export function normalizeSyncPath(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 1024) throw new Error('Invalid relative path')
  const normalized = input.replace(/\\/g, '/')
  if (
    normalized
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[<>:"|\u0000-\u001f\u007f]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
    throw new Error('Invalid relative path')
  return normalized
}

type Token = { kind: 'literal'; value: string } | { kind: 'one' | 'star' | 'recursive' | 'directories' }
const matchers = new Map<string, { test(path: string): boolean }>()

// Dynamic programming: O(path length * pattern length), with no regex backtracking.
export function compileSyncGlob(input: string): { test(path: string): boolean } {
  const cached = matchers.get(input)
  if (cached) return cached
  const glob = normalizeSyncPath(input)
  const tokens: Token[] = []
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        tokens.push({ kind: 'directories' })
        i += 2
      } else {
        tokens.push({ kind: 'recursive' })
        i++
      }
    } else if (c === '*') tokens.push({ kind: 'star' })
    else if (c === '?') tokens.push({ kind: 'one' })
    else tokens.push({ kind: 'literal', value: c })
  }
  const matcher = {
    test(path: string): boolean {
      let previous = new Uint8Array(path.length + 1)
      previous[0] = 1
      for (const token of tokens) {
        const next = new Uint8Array(path.length + 1)
        if (['star', 'recursive', 'directories'].includes(token.kind)) {
          next[0] = previous[0]
          let directoryStart = previous[0]
          for (let j = 1; j <= path.length; j++) {
            if (token.kind === 'directories') {
              next[j] = previous[j] || (path[j - 1] === '/' ? directoryStart : 0)
              directoryStart ||= previous[j]
            } else next[j] = previous[j] || (token.kind === 'recursive' || path[j - 1] !== '/' ? next[j - 1] : 0)
          }
        } else {
          for (let j = 1; j <= path.length; j++)
            next[j] = previous[j - 1] && (token.kind === 'literal' ? path[j - 1] === token.value : path[j - 1] !== '/') ? 1 : 0
        }
        previous = next
      }
      return previous[path.length] === 1
    }
  }
  if (matchers.size >= 512) matchers.delete(matchers.keys().next().value!)
  matchers.set(input, matcher)
  return matcher
}

export function isSyncPathAllowed(path: string, rules: SyncRule[]): boolean {
  const active = rules.filter((rule) => rule.enabled !== false)
  return (
    active.some((rule) => rule.action === 'INCLUDE' && compileSyncGlob(rule.path).test(path)) &&
    !active.some((rule) => rule.action === 'EXCLUDE' && compileSyncGlob(rule.path).test(path))
  )
}

export function validateFilePath(input: unknown): string {
  const path = normalizeSyncPath(input)
  if (/[?*]/.test(path)) throw new Error('Wildcards are only allowed in rules')
  return path
}
