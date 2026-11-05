// Packages are untrusted files: model.json and .livliv ZIPs, mutated at random (seeded, so a failure is reproduced by its
// seed), must either be read within the limits or refused with an Error, never hang, crash or reach outside the
// package. Then the hostile ZIPs on purpose: bombs, paths out of the package, too many entries, ZIP64.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { LIMITS, readModel } from '../src/runtime/format'
import { ZIP_LIMITS, unzip } from '../src/zip'

const example = () => JSON.parse(readFileSync(new URL('./fixtures/example-k01.model.json', import.meta.url), 'utf8'))
const SAFE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/

/** mulberry32: the same numbers for the same seed */
function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 }
}

const NASTY: unknown[] = [null, -1, 0, 1e9, -1e9, 1e308, 'x', '', '../../etc/passwd', 'textures/../../../x.webp', 'https://evil.example/x.png',
  '/abs.webp', 'C:\\x.png', 'javascript:alert(1)', [], {}, true, 'a'.repeat(100_000), Array.from({ length: 50_000 }, (_, i) => i)]

/** one random change somewhere in a JSON value: a key removed, a value replaced, a list multiplied */
function mutate(v: unknown, r: () => number): unknown {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const root = { v }
  let parent: Record<string, unknown> | unknown[] = root, key: string | number = 'v'
  for (let depth = 0; depth < 8 && r() < 0.8; depth++) {
    const cur = (parent as Record<string, unknown>)[key as string]
    if (!cur || typeof cur !== 'object') break
    const keys = Array.isArray(cur) ? cur.map((_, i) => i) : Object.keys(cur)
    if (!keys.length) break
    parent = cur as Record<string, unknown>; key = pick(keys as (string | number)[])
  }
  const p = parent as Record<string | number, unknown>, roll = r()
  if (roll < 0.25) { if (Array.isArray(p)) p.splice(key as number, 1); else delete p[key] }
  else if (roll < 0.85) p[key] = pick(NASTY)
  else if (Array.isArray(p[key])) { const a = p[key] as unknown[]; p[key] = Array.from({ length: Math.min(5000, a.length * 600 + 1) }, (_, i) => a[i % Math.max(1, a.length)]) }
  else p[key] = pick(NASTY)
  return root.v
}

/** a read model within the limits, every path inside the package */
function sound(m: ReturnType<typeof readModel>) {
  assert.ok(m.layers.length >= 1 && m.layers.length <= LIMITS.layers)
  assert.ok(m.canvas[0] > 0 && m.canvas[0] <= LIMITS.canvas && m.canvas[1] > 0 && m.canvas[1] <= LIMITS.canvas)
  for (const L of m.layers) {
    for (const p of [L.texture, ...(L.frames || []), L.mask, L.talk, L.brow_tex]) if (p !== undefined) assert.match(p, SAFE)
    assert.ok([L.x, L.y, L.w, L.h].every(Number.isFinite) && L.w > 0 && L.h > 0)
  }
}

describe('fuzz: model.json', () => {
  const v4 = example(), v3 = JSON.parse(JSON.stringify({ ...readModel(example(), 'en'), format: 'livemaker-puppet', version: 3, meta: undefined, files: undefined }))
  for (const [name, base] of [['v4', v4], ['v3', v3]] as const) {
    it(`${name}: 2000 mutated files are read soundly or refused with an Error`, () => {
      let read = 0, refused = 0
      for (let seed = 1; seed <= 2000; seed++) {
        const r = rng(seed)
        let m = JSON.parse(JSON.stringify(base))
        for (let k = 1 + Math.floor(r() * 4); k > 0; k--) m = mutate(m, r)
        const t0 = performance.now()
        try { sound(readModel(m, 'en')); read++ } catch (e) {
          if (e instanceof assert.AssertionError) throw new Error(`seed ${seed}: read, but not sound: ${e.message}`)
          assert.ok(e instanceof Error, `seed ${seed}: threw ${String(e)}`); refused++
        }
        assert.ok(performance.now() - t0 < 250, `seed ${seed}: took ${performance.now() - t0} ms`)
      }
      assert.ok(read > 0 && refused > 0, `read ${read}, refused ${refused}`)
    })
  }
})

// ---------------------------------------------------------------------------------------------- ZIPs
type Entry = { name: string; data: Uint8Array; deflate?: boolean; usize?: number }
/** a ZIP of the entries (stored, or deflated), its declared sizes overridable */
function zip(entries: Entry[]): Uint8Array {
  const enc = new TextEncoder(), parts: Uint8Array[] = [], cd: Uint8Array[] = []
  let off = 0
  for (const e of entries) {
    const name = enc.encode(e.name), body = e.deflate ? new Uint8Array(deflateRawSync(e.data)) : e.data
    const usize = e.usize ?? e.data.length
    const h = new DataView(new ArrayBuffer(30))
    h.setUint32(0, 0x04034b50, true); h.setUint16(8, e.deflate ? 8 : 0, true); h.setUint32(18, body.length, true); h.setUint32(22, usize, true)
    h.setUint16(26, name.length, true)
    const c = new DataView(new ArrayBuffer(46))
    c.setUint32(0, 0x02014b50, true); c.setUint16(10, e.deflate ? 8 : 0, true); c.setUint32(20, body.length, true); c.setUint32(24, usize, true)
    c.setUint16(28, name.length, true); c.setUint32(42, off, true)
    parts.push(new Uint8Array(h.buffer), name, body); cd.push(new Uint8Array(c.buffer), name)
    off += 30 + name.length + body.length
  }
  const cdLen = cd.reduce((s, x) => s + x.length, 0), end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true)
  end.setUint32(12, cdLen, true); end.setUint32(16, off, true)
  const all = [...parts, ...cd, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((s, x) => s + x.length, 0))
  let o = 0
  for (const x of all) { out.set(x, o); o += x.length }
  return out
}
const enc = (s: string) => new TextEncoder().encode(s)
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`still running after ${ms} ms`)), ms))])

describe('fuzz: .livliv', () => {
  const base = zip([
    { name: 'model.json', data: enc(JSON.stringify(example())) },
    { name: 'textures/body.webp', data: new Uint8Array(4096).map((_, i) => (i * 31) & 255) },
    { name: 'keyforms.json', data: enc(JSON.stringify({ version: 1, keys: [] }).repeat(50)), deflate: true },
  ])

  it('600 damaged packages are read within the limits or refused with an Error, none hangs', async () => {
    let read = 0, refused = 0
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed), b = base.slice()
      let bytes: Uint8Array = b
      const roll = r()
      if (roll < 0.4) for (let k = 1 + Math.floor(r() * 16); k > 0; k--) b[Math.floor(r() * b.length)] = Math.floor(r() * 256)
      else if (roll < 0.55) bytes = b.slice(0, Math.floor(r() * b.length))
      else if (roll < 0.7) { const at = Math.floor(r() * b.length); bytes = new Uint8Array([...b.slice(0, at), ...new Uint8Array(1 + Math.floor(r() * 64)).map(() => r() * 256), ...b.slice(at)]) }
      else { const at = Math.floor(r() * (b.length - 4)); new DataView(b.buffer).setUint32(at, [0, 0xffffffff, 0x7fffffff, Math.floor(r() * 2 ** 32)][Math.floor(r() * 4)], true) }
      try {
        const files = await within(unzip(new Blob([bytes as BlobPart])), 3000)
        let total = 0
        for (const [k, v] of files) { assert.match(k, /^(?![/\\])(?!.*(?:^|\/)\.\.(?:\/|$))/); total += v.size }
        assert.ok(total <= ZIP_LIMITS.bytes)
        read++
      } catch (e) {
        if (e instanceof assert.AssertionError || /still running/.test((e as Error).message)) throw new Error(`seed ${seed}: ${(e as Error).message}`)
        assert.ok(e instanceof Error, `seed ${seed}: threw ${String(e)}`); refused++
      }
    }
    assert.ok(read > 0 && refused > 0, `read ${read}, refused ${refused}`)
  })

  it('a bomb: 64 MB of zeros saying it is 1 KB stops at 1 KB', async () => {
    const b = zip([{ name: 'model.json', data: new Uint8Array(64 * 2 ** 20), deflate: true, usize: 1024 }])
    await assert.rejects(within(unzip(new Blob([b as BlobPart])), 5000), /inflates past/)
  })

  it('a bomb that says how big it is is refused before inflating', async () => {
    const b = zip([{ name: 'textures/a.webp', data: new Uint8Array(1024), deflate: true, usize: ZIP_LIMITS.bytes + 1 }])
    await assert.rejects(unzip(new Blob([b as BlobPart])), /too large/)
  })

  it('paths out of the package, too many entries, ZIP64 and encryption are refused', async () => {
    for (const name of ['../evil.json', 'textures/../../evil.webp', '/etc/passwd', 'C:/x.webp']) {
      await assert.rejects(unzip(new Blob([zip([{ name, data: enc('x') }]) as BlobPart])), /outside itself/, name)
    }
    const many = zip(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ name: `textures/${i}.webp`, data: enc('x') })))
    await assert.rejects(unzip(new Blob([many as BlobPart])), /entries/)
    const z64 = zip([{ name: 'model.json', data: enc('{}') }]), v = new DataView(z64.buffer)
    v.setUint16(z64.length - 22 + 10, 0xffff, true)
    await assert.rejects(unzip(new Blob([z64 as BlobPart])), /ZIP64/)
    const locked = zip([{ name: 'model.json', data: enc('{}') }]), w = new DataView(locked.buffer)
    w.setUint16(locked.length - 22 - 46 - 10 + 8, 1, true)  // the central directory entry's flags: encrypted
    await assert.rejects(unzip(new Blob([locked as BlobPart])), /encrypted/)
  })
})

describe('what a mesh would cost', () => {
  /** a model of `n` layers, each a box of 3 x the canvas (legal by itself): a tiny file for a big mesh */
  const big = (n: number, more: object = {}) => {
    const m = example(), first = m.layers[0]
    return { ...m, canvas: [768, 768], layers: Array.from({ length: n }, (_, i) => ({ ...first, id: `l${i}`, x: -768, y: -768, w: 2304, h: 2304, ...more })) }
  }
  it('counts vertices from the boxes', () => {
    assert.throws(() => readModel(big(15)), /vertices/)     // 15 x 148 225 > 2 097 152
    assert.doesNotThrow(() => readModel(big(14)))
  })
  it('counts vertices bent by chains, and refuses a chain named twice', () => {
    assert.throws(() => readModel(big(1, { bones: Array(3000).fill('c') })), /bones|chain/)
    assert.throws(() => readModel(big(1, { bones: ['c', 'c'] })), /twice/)
    assert.throws(() => readModel(big(8, { bones: ['a'] })), /bend/)  // 8 x 148 225 > 1 048 576
    assert.doesNotThrow(() => readModel(big(7, { bones: ['a'] })))
  })
  it('counts what brows layers read back', () => {
    const m = example(), first = m.layers[0]
    const boxes = { ...m, canvas: [8000, 8000], layers: [{ ...first, id: 'brows', x: -1000, y: -1000, w: 9000, h: 9000 }] }
    assert.throws(() => readModel(boxes), /brows layers/)
  })
})

describe('what the rig computes with', () => {
  const first = () => example().layers[0]
  const refused: [string, (m: ReturnType<typeof example>) => void, RegExp][] = [
    ['a chain with no id', (m) => { m.rig = { chains: [{ points: [[0, 0], [1, 1]], k: [1, 1], damp: 1, drive: 1, hang: 0, wind: 0 }] } }, /no id/],
    ['an empty chain', (m) => { m.rig = { chains: [null] } }, /no id/],
    ['a chain with one point', (m) => { m.rig = { chains: [{ id: 'c', points: [[0, 0]], k: [1, 1], damp: 1, drive: 1, hang: 0, wind: 0 }] } }, /two points/],
    ['a chain with no k', (m) => { m.rig = { chains: [{ id: 'c', points: [[0, 0], [1, 1]], damp: 1, drive: 1, hang: 0, wind: 0 }] } }, /no k/],
    ['a brow line with no bottom', (m) => { m.anchors.brows = [[1, 1, 5, 5]]; m.anchors.brow_lines = [{ x: [1, 2], lid: [3, 4] }] }, /brow line/],
    ['rig.roll as text', (m) => { m.rig = { ...m.rig, roll: 'x' } }, /rig\.roll/],
    ['rig.body.roll past any sense', (m) => { m.rig = { ...m.rig, body: { roll: 1e308 } } }, /rig\.body\.roll/],
    ['a spring chain of the wrong length', (m) => { m.rig = { ...m.rig, hair: { front: [1, 2] } } }, /rig\.hair\.front/],
    ['tuning as text', (m) => { m.tuning = { turn: 'x' } }, /tuning\.turn/],
    ['a role that is no text', (m) => { m.layers[0].role = 7 }, /role/],
    ['an unknown group', (m) => { m.layers[0].group = 'wings' }, /group/],
    ['a pivot of one number', (m) => { m.layers[0].pivot = [1] }, /pivot/],
    ['a blush weight as text', (m) => { m.layers[0].blush = { smile: 'x' } }, /blush/],
    ['an empty eye box', (m) => { m.anchors.eyes = [null] }, /eyes/],
  ]
  for (const [name, change, why] of refused) {
    it(`refuses ${name}`, () => {
      const m = example()
      change(m)
      assert.throws(() => readModel(m), why)
    })
  }
  it('takes what is simply missing, and null where a build wrote None', () => {
    const m = example()
    delete m.tuning; delete m.rig
    m.anchors.brows = [null, [1, 1, 5, 5]]; m.anchors.collar_y = null
    const { depth: _, ...noDepth } = first()
    m.layers[0] = noDepth
    assert.equal(readModel(m).layers[0].depth, 0)  // the schema's default
  })
})
