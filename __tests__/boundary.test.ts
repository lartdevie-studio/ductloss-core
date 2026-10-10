/**
 * 部品の境界を守る。
 *
 * 部品は単独で動く: src は相対 import だけで src の外を読まない。テストは vitest と node: だけ。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : files(p)
    return /\.(ts|tsx|md|mjs|json)$/.test(name) ? [p] : []
  })
}


const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g
const specifiers = (text: string) => [...text.matchAll(SPECIFIER)].map(m => m[2])

describe('部品の境界', () => {
  const SRC = join(ROOT, 'src')

  it('src は部品の外を import しない（相対 import だけで、src の中に収まる）', () => {
    const bad: string[] = []
    for (const p of files(SRC)) {
      for (const spec of specifiers(readFileSync(p, 'utf8'))) {
        const inside = spec.startsWith('./') || spec.startsWith('../')
          ? resolve(dirname(p), spec).startsWith(SRC)
          : false
        if (!inside) bad.push(`${p.replace(ROOT, '')}: ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('テストが使う外の部品は vitest と node: だけ', () => {
    const bad: string[] = []
    for (const p of files(join(ROOT, '__tests__'))) {
      for (const spec of specifiers(readFileSync(p, 'utf8'))) {
        if (spec.startsWith('./') || spec.startsWith('../')) {
          if (!resolve(dirname(p), spec).startsWith(ROOT)) bad.push(`${p.replace(ROOT, '')}: ${spec}`)
        } else if (spec !== 'vitest' && !spec.startsWith('node:')) {
          bad.push(`${p.replace(ROOT, '')}: ${spec}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

})
