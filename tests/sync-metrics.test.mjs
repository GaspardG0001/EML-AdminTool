import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createServer } from 'vite'

const db = {
  player: { count: async () => 2 },
  playerDevice: { count: async () => 3 },
  syncUpload: { count: async () => 1 },
  syncFile: {
    count: async () => 4,
    aggregate: async () => ({ _sum: { size: 40n } }),
    groupBy: async ({ by }) =>
      by[0] === 'objectKey' ? [{ objectKey: 'object', _max: { size: 20n } }] : [{ profileId: 'profile', _count: 4, _sum: { size: 40n } }]
  },
  profile: { findMany: async () => [{ id: 'profile', name: 'Minecraft' }] },
  syncMetric: undefined
}
globalThis.__syncMetricsDb = db
const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, ws: false },
  appType: 'custom',
  logLevel: 'error',
  resolve: { alias: { $lib: path.resolve('src/lib') } },
  plugins: [
    {
      name: 'metrics-db',
      enforce: 'pre',
      resolveId(source) {
        if (source === './db') return '\0metrics-db'
      },
      load(id) {
        if (id === '\0metrics-db') return 'export const db = globalThis.__syncMetricsDb'
      }
    }
  ]
})
const { getSyncStatistics } = await vite.ssrLoadModule('/src/lib/server/sync-metrics.ts')
after(async () => {
  delete globalThis.__syncMetricsDb
  await vite.close()
})

test('an older generated Prisma client does not break storage and player statistics', async () => {
  db.syncMetric = undefined
  const result = await getSyncStatistics()
  assert.equal(result.metricsAvailable, false)
  assert.deepEqual(result.metrics, {})
  assert.equal(result.players, 2)
  assert.equal(result.files, 4)
  assert.equal(result.logicalBytes, '40')
  assert.equal(result.referencedPhysicalBytes, '20')
})

test('a missing metrics table is reported as unavailable rather than crashing the dashboard', async () => {
  db.syncMetric = {
    findMany: async () => {
      throw Object.assign(new Error('Missing metrics table'), { code: 'P2021' })
    }
  }
  const result = await getSyncStatistics()
  assert.equal(result.metricsAvailable, false)
  assert.equal(result.devices, 3)
})

test('an up-to-date client exposes stored activity counters', async () => {
  db.syncMetric = { findMany: async () => [{ name: 'uploads_committed', count: 15n }] }
  const result = await getSyncStatistics()
  assert.equal(result.metricsAvailable, true)
  assert.deepEqual(result.metrics, { uploads_committed: '15' })
})

test('unexpected database failures remain visible', async () => {
  db.syncMetric = {
    findMany: async () => {
      throw Object.assign(new Error('Database unavailable'), { code: 'P1001' })
    }
  }
  await assert.rejects(getSyncStatistics(), { code: 'P1001' })
})
