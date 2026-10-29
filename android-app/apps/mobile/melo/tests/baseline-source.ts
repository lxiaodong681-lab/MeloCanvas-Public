import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Only reviewed source blobs are retained, never the private Git object database.
const manifest = JSON.parse(
	readFileSync(new URL('./baselines/manifest.json', import.meta.url), 'utf8'),
) as Record<string, { file: string; sha256: string }>

export function readBaselineSource(reference: string): string {
	const entry = manifest[reference]
	if (!entry) throw new Error('Unknown regression baseline')
	const source = readFileSync(new URL(entry.file, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
	if (createHash('sha256').update(source).digest('hex') !== entry.sha256)
		throw new Error('Regression baseline checksum mismatch')
	return source
}
