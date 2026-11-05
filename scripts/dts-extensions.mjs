#!/usr/bin/env node
// The declarations as tsc writes them keep the source's relative imports, without extensions: fine for a bundler, but under
// moduleResolution node16 / nodenext (a package with "type": "module") each is an error or, with skipLibCheck, silently
// `any`. This gives them the extension the files have at run time, after `tsc -p tsconfig.build.json`.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] || 'dist/types')
const IMPORT = /((?:from\s+|import\s*\(\s*|^\s*import\s+)['"])(\.\.?\/[^'"]+?)(['"])/gm
let changed = 0
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
for (const f of walk(root).filter((f) => f.endsWith('.d.ts'))) {
  const text = fs.readFileSync(f, 'utf8')
  const out = text.replace(IMPORT, (m, a, spec, z) => {
    if (!fs.existsSync(path.resolve(path.dirname(f), `${spec}.d.ts`))) throw new Error(`${path.relative(root, f)} imports ${spec}: no such declaration`)
    changed++
    return `${a}${spec}.js${z}`
  })
  if (out !== text) fs.writeFileSync(f, out)
}
console.log(`declarations: ${changed} relative imports now say .js`)
