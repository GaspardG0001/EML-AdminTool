export function formatBytes(value: bigint | string): string {
  const bytes = typeof value === 'bigint' ? value : BigInt(value)
  if (bytes < 1024n) return `${bytes.toLocaleString('fr-FR')} o`

  const units = ['Kio', 'Mio', 'Gio', 'Tio', 'Pio']
  let amount = Number(bytes)
  let unitIndex = -1
  do {
    amount /= 1024
    unitIndex++
  } while (amount >= 1024 && unitIndex < units.length - 1)

  return `${amount.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${units[unitIndex]}`
}
