// 部品を配る形に組み立てる: dist/index.js（ESM・1 ファイル）と dist/types/*.d.ts（型）。
//
// 元のファイルは拡張子なしの import で書いてある（Monosashi の Next.js がそのまま読むため）。
// 配る JS は esbuild で 1 ファイルに束ねるので拡張子は要らない。型は tsc で出したあと、
// Node の ESM（NodeNext）で読めるよう、相対の import に .js を付け直す。
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
rmSync(dist, { recursive: true, force: true })

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(dist, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  legalComments: 'inline',
  banner: { js: '// @monosashi/ductloss-core — MIT License (see LICENSE)' },
})

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })

const typesDir = join(dist, 'types')
for (const name of readdirSync(typesDir)) {
  if (!name.endsWith('.d.ts')) continue
  const p = join(typesDir, name)
  const text = readFileSync(p, 'utf8').replace(/(from\s+|import\()(['"])(\.\.?\/[^'"]+?)(\2)/g,
    (m, pre, q, spec) => (spec.endsWith('.js') ? m : `${pre}${q}${spec}.js${q}`))
  writeFileSync(p, text)
}
console.log('組み立てました → dist/index.js, dist/types/')
