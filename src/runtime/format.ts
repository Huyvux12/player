// model.json as the player reads it: the public format, `livliv-model` version 4, lowered to the shape the
// runtime has always drawn from (ModelDef, the v3 `livemaker-puppet` layout), and v3 itself, read as it is, for good.
// The runtime below never sees a v4 file: what changed in v4 is names, places and what is left out, not how a model
// is drawn (a v3 model and its v4 export draw the same pixels).
import type { LayerDef, ModelDef, Tuning } from './puppet'

/** model.json's `format` and the newest `version` of it this player reads. A v4 file names, in `requires`, the
 *  features a player must have to draw it right (FEATURES: none in 4.0); fields it does not know it ignores */
export const FORMAT = 'livliv-model', FORMAT_VERSION = 4
/** the format every model built before v4 has, and exports made until then: read as it is, whatever comes later */
export const LEGACY_FORMAT = 'livemaker-puppet', LEGACY_VERSION = 3
export const FEATURES: readonly string[] = []

/** names by language (BCP 47 tag -> text): an expression's, a layer's */
export type Labels = Record<string, string>
/** center (kind livliv only): false draws the logo in the corner alone, without the light one over the character (the
 *  featured characters); missing or true, both (the free plan's) */
export interface Watermark { kind: 'livliv' | 'text' | 'none'; text?: string; center?: boolean }
/** v4's `meta`: who and what made the package, under what terms, and the mark it asks the player to draw */
export interface ModelMeta {
  generator: { name: string; build?: string }
  created?: string
  author?: { name: string; url?: string }
  license?: { id: string; url?: string; text?: string }
  watermark?: Watermark
}
/** v4's `files`: the optional files in the package, by what they are for */
export interface ModelFiles { keyforms?: string; avatar?: string; cover?: string; preview?: string }

/** limits a package is held to before anything is fetched, and before its images reach the GPU. A
 *  model.json is untrusted input (a package from anyone): these keep a broken or hostile one from hanging the page or
 *  filling its memory. The largest models LivLiv has built use a tenth of them or less (53 layers, 73 images, 8.5 M
 *  texels, 1536 px, a 22 KB model.json, 3 MB of keyforms) */
export const LIMITS = {
  canvas: 8192, layers: 512, images: 2048, expressions: 256, eyes: 16, chains: 64, points: 256,
  /** an image's side (px) and all the model's images' pixels */
  texture: 8192, texels: 64 * 2 ** 20,
  /** model.json and keyforms.json (bytes) */
  modelJson: 4 * 2 ** 20, keyforms: 32 * 2 ** 20,
}
const IMAGE = /^textures\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:webp|png)$/
const FILE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/

const read = new WeakSet<object>()

/** A model.json as the runtime draws it: v3 as it is (the same object), v4 lowered into a new one. Throws on anything
 *  else, on a newer version than this player reads, and on a feature in `requires` it does not have. `lang` picks the
 *  expressions' `label` from their names by language (all of them stay in `labels`). Reading a result again returns
 *  it as it is */
export function readModel(raw: unknown, lang = uiLang()): ModelDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a LivLiv model (model.json is not an object)')
  if (read.has(raw)) return raw as ModelDef
  const m = raw as Record<string, unknown>
  if (m.format === undefined || m.format === LEGACY_FORMAT) {
    const v = (m.version as number | undefined) ?? LEGACY_VERSION
    if (v > LEGACY_VERSION) throw new Error(`this model says format "${LEGACY_FORMAT}" version ${v}, which never existed`)
    check(m as unknown as ModelDef)
    read.add(m)
    return m as unknown as ModelDef
  }
  if (m.format !== FORMAT) throw new Error(`not a LivLiv model (format "${String(m.format)}")`)
  const v = m.version as number
  if (typeof v !== 'number' || v > FORMAT_VERSION) {
    throw new Error(`this model is format version ${v}; this player reads up to ${FORMAT_VERSION}: update the player`)
  }
  const missing = ((m.requires as string[] | undefined) || []).filter((f) => !FEATURES.includes(f))
  if (missing.length) throw new Error(`this model needs ${missing.join(', ')}, which this player does not have: update the player`)
  const out = lower(m as unknown as V4, lang)
  check(out)
  read.add(out)
  return out
}

/** what any model must be before it is drawn, whatever wrote it: sizes and counts in range (LIMITS), numbers finite,
 *  every image and file a path inside the package. Throws on the first thing wrong */
function check(m: ModelDef) {
  const bad = (why: string): never => { throw new Error(`this model is not valid: ${why}`) }
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const list = (v: unknown, most: number, what: string) => {
    if (v === undefined) return []
    if (!Array.isArray(v) || v.length > most) bad(`${what} is not a list of at most ${most}`)
    return v as unknown[]
  }
  const [w = NaN, h = NaN] = Array.isArray(m.canvas) ? m.canvas : []
  if (!(num(w) && num(h) && w > 0 && h > 0 && w <= LIMITS.canvas && h <= LIMITS.canvas)) bad(`its canvas ${w} x ${h} is out of range`)
  if (!Array.isArray(m.layers) || !m.layers.length) bad('it has no layers')
  if (m.layers.length > LIMITS.layers) bad(`it has ${m.layers.length} layers, more than ${LIMITS.layers}`)
  const A = m.anchors, hd = A?.head
  if (!hd || ![hd.cx, hd.cy, hd.rx, hd.ry, A.neck_y, A.top_y, A.bottom_y, A.hair_root_y].every(num) || !(hd.rx > 0 && hd.ry > 0)
    || !Array.isArray(A.face) || A.face.length !== 4 || !A.face.every(num)) bad('its anchors are missing or not numbers')
  list(A.eyes, LIMITS.eyes, 'anchors.eyes'); list(A.brows, LIMITS.eyes, 'anchors.brows')
  for (const line of list(A.brow_lines, LIMITS.eyes, 'anchors.brow_lines') as ({ x?: unknown } | null)[]) {
    if (line) list(line.x, LIMITS.points, 'a brow line')
  }
  let images = 0
  for (const L of m.layers) {
    if (!L || typeof L !== 'object' || typeof L.id !== 'string') bad('a layer has no id')
    if (![L.x, L.y, L.w, L.h].every(num) || !(L.w > 0 && L.h > 0) || L.x < -w || L.y < -h || L.x + L.w > 2 * w || L.y + L.h > 2 * h) {
      bad(`layer ${L.id.slice(0, 60)}'s box is out of range`)
    }
    if (typeof L.texture !== 'string') bad(`layer ${L.id.slice(0, 60)} has no texture`)
    for (const p of [L.texture, ...list(L.frames, LIMITS.images, `layer ${L.id.slice(0, 60)}'s frames`), L.mask, L.talk, L.brow_tex]) {
      if (p === undefined) continue
      if (typeof p !== 'string' || !FILE.test(p)) bad(`layer ${L.id.slice(0, 60)}: "${String(p).slice(0, 80)}" is not a path inside the package`)
      if (++images > LIMITS.images) bad(`it names more than ${LIMITS.images} images`)
    }
  }
  list(m.expressions, LIMITS.expressions, 'expressions')
  for (const c of list(m.rig?.chains, LIMITS.chains, 'rig.chains') as { points?: unknown }[]) list(c?.points, LIMITS.points, 'a chain')
  if (m.keyforms !== undefined && (typeof m.keyforms !== 'string' || !FILE.test(m.keyforms))) bad('keyforms is not a path inside the package')
  if (m.watermark != null && typeof m.watermark !== 'string') bad('its watermark is not text')
}

interface V4Layer extends Omit<LayerDef, 'name'> { label?: Labels; expression?: string }
interface V4 {
  format: string; version: number; name: string; meta: ModelMeta; requires?: string[]; files?: ModelFiles
  canvas: [number, number]; profile?: { id: string; facing?: string; glasses?: boolean }
  rig?: ModelDef['rig']; tuning?: Partial<Tuning> & { hair_front?: number; hair_back?: number }
  anchors: ModelDef['anchors']; expressions?: { id: string; label: Labels; hotkey?: string }[]; layers: V4Layer[]
}

function lower(m: V4, lang: string): ModelDef {
  if (!Array.isArray(m.layers) || !m.layers.length) throw new Error('this model has no layers')
  if (m.layers.length > LIMITS.layers) throw new Error(`this model has ${m.layers.length} layers, more than ${LIMITS.layers}`)
  const [w, h] = m.canvas || []
  if (!(w > 0 && h > 0 && w <= LIMITS.canvas && h <= LIMITS.canvas)) throw new Error(`this model's canvas ${w} x ${h} is out of range`)
  for (const L of m.layers) {
    for (const p of [L.texture, ...(L.frames || []), L.mask, L.talk, L.brow_tex]) {
      if (p !== undefined && !IMAGE.test(p)) throw new Error(`layer ${L.id}: "${p}" is not an image path of the package`)
    }
  }
  for (const [k, p] of Object.entries(m.files || {})) {
    if (!k.startsWith('x-') && (typeof p !== 'string' || !FILE.test(p))) throw new Error(`files.${k}: "${p}" is not a path in the package`)
  }
  const layers = m.layers.map(({ label, expression, ...L }) =>
    ({ ...L, name: label ? pickLabel(label, 'en', L.id) : L.id, ...(expression ? { param: expression } : {}) }) as LayerDef)
  let tuning: Partial<Tuning> | undefined
  if (m.tuning) {
    const { hair_front, hair_back, ...t } = m.tuning
    tuning = { ...t, ...(hair_front !== undefined ? { hairFront: hair_front } : {}), ...(hair_back !== undefined ? { hairBack: hair_back } : {}) }
  }
  const p = m.profile
  const mark = m.meta?.watermark
  return {
    format: m.format, version: m.version, name: m.name, canvas: m.canvas, anchors: m.anchors, layers, rig: m.rig, tuning,
    // lidCurveFits reads the two things v4 keeps of the classifier's view where v3 kept all of it
    profile: p && { id: p.id, label: '', class: { input: { facing: p.facing, glasses: p.glasses } } },
    expressions: (m.expressions || []).map((e) => ({ id: e.id, label: pickLabel(e.label, lang, e.id), labels: e.label,
      ...(e.hotkey ? { key: e.hotkey } : {}) })),
    keyforms: m.files?.keyforms,
    watermark: mark?.kind === 'livliv' ? 'LivLiv' : mark?.kind === 'text' ? mark.text ?? null : null,
    meta: m.meta, files: m.files,
  }
}

/** the page's language (the browser's), for picking names */
export function uiLang(): string {
  return (typeof navigator !== 'undefined' && navigator.language) || 'en'
}

/** a name in `lang`: that tag, its script (zh-TW -> zh-Hant), its language, then English, Chinese, any, `fallback` */
export function pickLabel(labels: Labels | undefined, lang: string, fallback: string): string {
  if (!labels) return fallback
  const keys = Object.keys(labels), find = (t: string) => keys.find((k) => k.toLowerCase() === t.toLowerCase())
  const tag = lang || 'en', base = tag.split('-')[0].toLowerCase()
  const hant = base === 'zh' && /-(hant|tw|hk|mo)\b/i.test(tag)
  for (const t of [tag, ...(base === 'zh' ? [hant ? 'zh-Hant' : 'zh-Hans'] : []), base, ...(hant ? ['zh'] : []), 'en', 'zh']) {
    const k = find(t)
    if (k && labels[k]) return labels[k]
  }
  return keys.length ? labels[keys[0]] : fallback
}

/** the language a name was written in, as v4 stores a name it has in one language only: kana ja, hangul ko, han zh,
 *  anything else en */
export function langOf(text: string): string {
  if (/[぀-ヿ]/.test(text)) return 'ja'
  if (/[가-힯]/.test(text)) return 'ko'
  if (/[一-鿿]/.test(text)) return 'zh'
  return 'en'
}
