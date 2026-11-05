// @livliv/player: plays a LivLiv model (an exported model package: model.json and textures/) on a canvas, outside
// livliv.ai. The renderer is livliv.ai's own (src/runtime/puppet.ts); this wraps it in a small API: load, a frame
// loop with the idle motion, params, expressions, actions, the corner mark the package carries, and drivers. Face
// tracking and lip sync are separate imports ('@livliv/player/tracking', '@livliv/player/voice'), so the core stays small.
//
// Each frame the pose is put together from scratch: your `params`, then the idle motion (head, eyes, brows, body,
// breath; follow.ts: livliv.ai's, following the pointer with the eyes and the face), then the drivers in order, then
// actions and expressions. Nothing the player adds is written back to
// `params`, so a value you set stays until you change it, and turning a driver off leaves no trace.
import { ActionPlayer, type ActionId } from './runtime/actions'
import { langOf, pickLabel, readModel, uiLang, type Labels, type ModelMeta } from './runtime/format'
import { FORMAT, FORMAT_VERSION, LEGACY_FORMAT, PARAM_RANGES, Puppet, defaultParams, loadBlob, type KeyformFile, type ModelDef, type Params } from './runtime/puppet'
import { Idle } from './follow'
import { Mark } from './mark'
import { ZIP_LIMITS, isZip, unzip } from './zip'

export { FORMAT, FORMAT_VERSION, LEGACY_FORMAT, PARAM_RANGES, defaultParams }
export type { ActionId, Labels, ModelDef, ModelMeta, Params }

/** this package's version */
export const VERSION = '0.2.0'

/** where a model comes from: the URL of its model.json, of the folder holding it, or of a .livliv package (relative URLs
 *  resolve against the page); a .livliv package itself (a File or Blob: a ZIP of the folder); or its files: a FileList /
 *  File[] from an <input type="file"> (a folder with webkitdirectory, or one picked .livliv), or a map of path -> Blob */
export type ModelSource = string | URL | Blob | FileList | Iterable<File> | Map<string, Blob> | Record<string, Blob>

export interface PlayerOptions {
  /** move by itself: breathe, blink, sway, look around (default true). Off: only your params and drivers move it */
  idle?: boolean
  /** the eyes and head follow the pointer anywhere on the page ('page', the default), only over the canvas
   *  ('canvas'), or not at all (false) */
  followPointer?: 'page' | 'canvas' | false
  /** drawing-buffer pixels per CSS pixel at most (default 2; 1 saves power on high-DPI screens) */
  maxPixelRatio?: number
  /** start the frame loop at once (default true) */
  autoplay?: boolean
  /** the language expression names are picked in (`expressions[].label`; a BCP 47 tag, default the browser's) */
  lang?: string
}

export interface ModelInfo {
  name: string
  /** model.json's format: FORMAT ("livliv-model"), or LEGACY_FORMAT ("livemaker-puppet") for packages exported before v4 */
  format: string
  /** its version (FORMAT_VERSION is the newest this player reads; a legacy package is 3) */
  version: number
  /** the size the character was drawn at, in pixels */
  size: [number, number]
  /** what setExpression() takes: `id` (smile, shy, angry ... mean the same on every model; x_… is the model's own),
   *  `label` its name in the player's language, `labels` every language's (BCP 47 tag -> name) */
  expressions: { id: string; label: string; labels: Labels }[]
  /** the mark drawn over the character: "LivLiv" (the free plan's), the owner's own text, or null */
  watermark: string | null
  /** v4 packages: who made it (author), the terms it comes under (license), what wrote it and when; null before v4 */
  meta: ModelMeta | null
}

/** the build's smile on a model whose list was never written (packages from before 2026-10) */
const SMILE: Labels = { zh: '笑', 'zh-Hant': '笑', en: 'Smile', ja: '笑顔' }

/** where the character sits in the canvas: x, y move it by shares of the canvas (y up), zoom scales it about the
 *  center; head: frame the head instead of the whole drawing (avatars, chat bubbles) */
export interface View { x: number; y: number; zoom: number; head: boolean }

/** one frame being put together, as a driver sees it */
export interface Frame {
  /** the pose so far: write to it (for this frame only) */
  readonly params: Params
  /** seconds since the last frame, and since the model loaded */
  readonly dt: number
  readonly time: number
  /** a face tracker drives the head this frame (lip sync then leaves the head alone) */
  tracked: boolean
  /** add to params, kept in their ranges */
  add(offsets: Partial<Params>): void
  /** move the picture: x, y shares of the canvas (y up), s a scale */
  readonly move: { x: number; y: number; s: number }
}

/** something that moves the character each frame: face tracking and lip sync are drivers, and your own code can be */
export interface Driver {
  /** lower runs first: face tracking -10, yours 0 (default), lip sync 10 */
  order?: number
  update(frame: Frame, player: Host): void
  /** called when it is removed, or the player disposed */
  dispose?(): void
}

/** what a driver, the lip sync and the face tracking need of a player: a Player, or a BodyPlayer (@livliv/player/body) */
export interface Host {
  /** adds a driver; returns a function that removes it */
  use(driver: Driver): () => void
  /** blinks now (with the idle motion on) */
  blink(): void
}


/** what the runtime throws when a canvas gives it no WebGL2 context */
const NO_WEBGL2 = 'this browser has no WebGL2'

/** Plays one LivLiv model on a canvas. Size the canvas with CSS; the drawing follows its size. */
export class Player implements Host {
  readonly canvas: HTMLCanvasElement
  /** the renderer underneath, for what this API does not cover. Its fields can change between versions */
  readonly puppet: Puppet
  /** your values for the pose and face (ranges in PARAM_RANGES). The player never changes them */
  readonly params: Params = defaultParams()
  /** see PlayerOptions.idle */
  idle: boolean
  /** see PlayerOptions.followPointer */
  followPointer: 'page' | 'canvas' | false
  readonly view: View = { x: 0, y: 0, zoom: 1, head: false }
  /** see PlayerOptions.lang */
  readonly lang: string

  private info: ModelInfo | null = null
  private mark: Mark
  private idler = new Idle()
  /** last frame's: a face tracker drove it, the mouth moved (the idle starts no move while the character talks) */
  private was = { tracked: false, mouth: 0 }
  private actions = new ActionPlayer()
  private drivers: Driver[] = []
  private expr: Record<string, number> = {}
  private smile = 0
  private raf = 0
  private last = 0
  private visible = true
  private io?: IntersectionObserver
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  private frame: Frame & { move: { x: number; y: number; s: number } }

  /** Whether this browser can play a LivLiv model (WebGL2 starts on a new canvas). Where it cannot, new Player() throws */
  static isSupported(): boolean {
    const gl = document.createElement('canvas').getContext('webgl2')
    gl?.getExtension('WEBGL_lose_context')?.loseContext()  // the try takes none of the contexts a page may have at once
    return !!gl
  }

  constructor(canvas: HTMLCanvasElement, options: PlayerOptions = {}) {
    this.canvas = canvas
    try {
      this.puppet = new Puppet(canvas)
    } catch (e) {
      throw new Error(typeof WebGL2RenderingContext === 'undefined' ? 'LivLiv: this browser has no WebGL2'
        : (e as Error).message === NO_WEBGL2 ? 'LivLiv: could not start WebGL2 on this canvas: it is turned off in this browser, or the canvas already draws in 2D'
          : `LivLiv: could not start WebGL2 on this canvas (${(e as Error).message})`)
    }
    this.puppet.maxDpr = options.maxPixelRatio ?? 2
    this.mark = new Mark(this.puppet.gl)
    this.idle = options.idle ?? true
    this.followPointer = options.followPointer ?? 'page'
    this.lang = options.lang || uiLang()
    const P = this.puppet.params
    this.frame = {
      params: P, dt: 0, time: 0, tracked: false, move: { x: 0, y: 0, s: 1 },
      add(o) {
        for (const [k, v] of Object.entries(o) as [keyof Params, number | undefined][]) {
          if (v) P[k] = Math.max(PARAM_RANGES[k][0], Math.min(PARAM_RANGES[k][1], P[k] + v))
        }
      },
    }
    addEventListener('pointermove', this.onMove)
    document.addEventListener('pointerleave', this.onLeave)
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((e) => { this.visible = e[e.length - 1].isIntersecting })
      this.io.observe(canvas)
    }
    if (options.autoplay ?? true) this.play()
  }

  /** the loaded model (null before the first load) */
  get model(): ModelInfo | null { return this.info }
  get expressions() { return this.info?.expressions ?? [] }
  get playing() { return this.raf !== 0 }

  /** Loads a model (see ModelSource) and shows it in place of the one before. Loads run one after another */
  load(source: ModelSource): Promise<ModelInfo> {
    const run = this.queue.then(() => this.loadNow(source))
    this.queue = run.catch(() => {})
    return run
  }

  private async loadNow(source: ModelSource): Promise<ModelInfo> {
    const stillHere = () => { if (this.disposed) throw new Error('LivLiv: the player was disposed') }
    stillHere()
    const p = this.puppet
    let files: Exclude<ModelSource, string | URL> | null = null
    if (typeof source === 'string' || source instanceof URL) {
      const url = new URL(String(source), document.baseURI)
      if (/\.(livliv|zip)$/i.test(url.pathname)) { files = await fetchPackage(url.href); stillHere() } else {
        try {
          await p.load(url.href, { pack: false })
        } catch (e) {
          throw explain(e, url.href)
        }
      }
    } else files = source
    if (files) {
      const { model, image, keyforms } = await fromFiles(files)
      stillHere()
      await p.loadModel(model, image, { keyforms }).catch((e) => { throw explain(e, 'model.json') })
    }
    // disposed while the images came in: the runtime built its layers all the same; nothing of them may stay or be drawn
    if (this.disposed) p.dispose()
    stillHere()
    const m = p.model
    const ex = m.expressions || (m.layers.some((l) => l.id === 'expr_smile') ? [{ id: 'smile', label: '', labels: SMILE }] : [])
    this.info = {
      name: m.name, format: m.format || LEGACY_FORMAT, version: m.version ?? 3, size: m.canvas,
      // a legacy package names each expression once, in the language its owner wrote it in
      expressions: ex.map(({ id, label, labels }) => {
        const all = labels || { [langOf(label)]: label }
        return { id, label: pickLabel(all, this.lang, id), labels: all }
      }),
      watermark: m.watermark ?? null, meta: m.meta ?? null,
    }
    // v4 says which mark it is; before it the text "LivLiv" meant the logo
    const kind = m.meta ? m.meta.watermark?.kind ?? 'none' : m.watermark === 'LivLiv' ? 'livliv' : m.watermark ? 'text' : 'none'
    this.mark.set(kind, m.watermark ?? null, m.meta?.watermark?.center !== false)
    this.expr = {}; this.smile = 0
    if (!this.playing) this.draw(0)
    return this.info
  }

  /** Shows an expression (an id from `expressions`), easing over from the one before; null goes back to neutral.
   *  weight: how strongly, 0..1. False when the model has no such expression */
  setExpression(id: string | null, weight = 1): boolean {
    if (id !== null && !this.expressions.some((e) => e.id === id)) return false
    const w = Math.max(0, Math.min(1, weight))
    this.smile = id === 'smile' ? w : 0
    this.expr = id === null || id === 'smile' ? {} : { [id]: w }
    return true
  }

  /** Plays a short move over whatever drives the character: nod, shake, tilt, hop, shy. 'away' toggles a dozing pose */
  act(action: ActionId) { this.actions.play(action) }

  /** Looks toward (x, y), each -1..1 from the canvas center (y up), instead of following the pointer; null goes back to
   *  following it. Needs the idle motion on */
  lookAt(x: number | null, y = 0) {
    this.idler.lookAt(this.puppet, x === null ? null : clamp(x, -1, 1), clamp(y, -1, 1), this.canvas.clientWidth, this.canvas.clientHeight)
  }

  /** Blinks now (with the idle motion on) */
  blink() { this.idler.blink(this.puppet.time) }

  /** Adds a driver; returns a function that removes it. On a disposed player it is disposed at once: what started
   *  while the player went (a camera, a microphone) does not stay on */
  use(driver: Driver): () => void {
    if (this.disposed) { driver.dispose?.(); return () => {} }
    this.drivers.push(driver)
    this.drivers.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    return () => {
      const i = this.drivers.indexOf(driver)
      if (i >= 0) { this.drivers.splice(i, 1); driver.dispose?.() }
    }
  }

  play() {
    if (this.raf || this.disposed) return
    this.last = performance.now()
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (now - this.last) / 1000)
      this.last = now
      if (this.visible) this.draw(dt)
    }
    this.raf = requestAnimationFrame(loop)
  }

  pause() { cancelAnimationFrame(this.raf); this.raf = 0 }

  /** Draws now at the canvas's current size. A playing player follows the size by itself; call this after resizing a
   *  paused one */
  resize() { this.draw(0) }

  /** The current frame as an image (PNG data URL), the mark included */
  snapshot(): string { return this.canvas.toDataURL('image/png') }

  /** Stops, removes the drivers and frees the GPU memory. A load still running rejects. The canvas can take a new Player
   *  afterwards */
  dispose() {
    if (this.disposed) return
    this.pause()
    this.disposed = true
    removeEventListener('pointermove', this.onMove)
    document.removeEventListener('pointerleave', this.onLeave)
    this.io?.disconnect()
    for (const d of this.drivers.splice(0)) d.dispose?.()
    const gl = this.puppet.gl
    this.puppet.dispose(); this.mark.dispose(); gl.deleteProgram(this.puppet.prog)
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
    this.info = null
  }

  private draw(dt: number) {
    const p = this.puppet, P = p.params, f = this.frame
    if (!p.model || this.disposed) return
    // the pose from scratch: your values, the idle motion, the drivers
    this.idler.shown(P)
    Object.assign(P, this.params)
    if (this.idle) {
      this.idler.apply(P, p.time, dt, { busy: this.actions.busy || this.was.mouth > 0.05, tracked: this.was.tracked,
        faceFree: !this.smile && !Object.values(p.expr).some((v) => v > 0.02) })
    }
    Object.assign(f, { dt, time: p.time, tracked: false })
    Object.assign(f.move, { x: 0, y: 0, s: 1 })
    for (const d of this.drivers) d.update(f, this)
    this.was = { tracked: f.tracked, mouth: P.mouthOpen }
    const A = this.actions
    f.add(A.update(dt))
    if (this.smile) P.smile = Math.max(P.smile, this.smile)
    if (A.awayW) for (const [k, v] of Object.entries(A.awayPose(p.time)) as [keyof Params, number][]) P[k] += (v - P[k]) * A.awayW
    // expressions ease in and out (one no longer shown eases back to 0); dozing hides them, each is a face with open eyes
    for (const k of Object.keys(this.expr)) if (!(k in p.expr)) p.expr[k] = 0
    for (const k of Object.keys(p.expr)) p.expr[k] += ((this.expr[k] ?? 0) * (1 - A.awayW) - p.expr[k]) * Math.min(1, dt * 8)
    const V = this.view
    p.view = { x: V.x, y: V.y, s: V.zoom }
    p.focusHead = V.head
    p.move = { x: f.move.x, y: f.move.y + A.y, s: f.move.s }
    p.update(dt)
    p.render()
    this.mark.draw(performance.now(), p.gl.drawingBufferWidth / Math.max(1, this.canvas.clientWidth))
  }

  private onMove = (e: PointerEvent) => {
    if (!this.followPointer) return
    const r = this.canvas.getBoundingClientRect()
    // 'canvas': off it the pointer has left the stage, and the character looks back at the viewer
    const inside = !(e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
    this.idler.pointer(this.puppet, e.clientX - r.left, e.clientY - r.top, r.width, r.height, this.followPointer === 'page' || inside)
  }
  private onLeave = () => this.idler.leave()
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** errors in the words of someone embedding the player (the runtime's own are written for livliv.ai) */
function explain(e: unknown, where: string): Error {
  const err = e as Error & { status?: number }
  const msg = String(err?.message || e)
  if (err?.status) return new Error(`LivLiv: could not load ${where} (HTTP ${err.status})`)
  if (msg.startsWith('image ')) {
    return new Error(`LivLiv: could not load the image ${msg.slice(6)}: it is missing, or on another origin that sends no CORS header`)
  }
  if (err instanceof SyntaxError) return new Error(`LivLiv: ${where} is not a model.json (${msg})`)
  if (err instanceof TypeError && /fetch/i.test(msg)) {
    return new Error(`LivLiv: could not load ${where}: unreachable, or on another origin that sends no CORS header`)
  }
  return new Error(msg.startsWith('LivLiv') ? msg : `LivLiv: ${msg}`)
}

/** a .livliv package from a URL, as a Blob */
async function fetchPackage(url: string): Promise<Blob> {
  const r = await fetch(url).catch((e) => { throw explain(e, url) })
  if (!r.ok) throw explain(Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }), url)
  return r.blob()
}

/** a model from files: model.json (the shallowest one) and its images by their paths relative to it, and its keyforms
 *  when it declares them. A .livliv package (a Blob, or the one zip among picked files) is opened first; its files may
 *  sit inside one folder (a ZIP made with the system's "compress") */
async function fromFiles(source: Exclude<ModelSource, string | URL>) {
  const files = new Map<string, Blob>()
  const norm = (k: string) => k.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '')
  const unpack = async (b: Blob) => {
    if (!(await isZip(b))) throw new Error('LivLiv: this file is not a .livliv package (not a ZIP)')
    return unzip(b).catch((e) => { throw explain(e, 'the package') })
  }
  if (source instanceof Blob) (await unpack(source)).forEach((b, k) => files.set(k, b))
  else if (source instanceof Map) source.forEach((b, k) => files.set(norm(k), b))
  else if (Symbol.iterator in source) for (const f of source as Iterable<File>) files.set(norm(f.webkitRelativePath || f.name), f)
  else for (const [k, b] of Object.entries(source)) files.set(norm(k), b)
  const isJson = (k: string) => k === 'model.json' || k.endsWith('/model.json')
  if (!(source instanceof Blob) && ![...files.keys()].some(isJson)) {  // one picked package
    for (const b of files.values()) {
      if (await isZip(b)) { const z = await unpack(b); files.clear(); z.forEach((v, k) => files.set(k, v)); break }
    }
  }
  const json = [...files.keys()].filter(isJson).sort((a, b) => a.length - b.length)[0]
  if (!json) throw new Error('LivLiv: no model.json among the files')
  const dir = json.slice(0, json.length - 'model.json'.length)
  if (files.get(json)!.size > ZIP_LIMITS.modelJson) throw new Error(`LivLiv: ${json} is larger than ${ZIP_LIMITS.modelJson} bytes`)
  let model: ModelDef
  try {
    model = readModel(JSON.parse(await files.get(json)!.text()))
  } catch (e) {
    throw explain(e, json)
  }
  // by path, or by name alone when the files were picked one by one (no folders)
  const byName = new Map<string, Blob>()
  files.forEach((b, k) => byName.set(k.slice(k.lastIndexOf('/') + 1), b))
  const find = (path: string) => files.get(dir + norm(path)) ?? byName.get(path.slice(path.lastIndexOf('/') + 1))
  const image = (path: string) => {
    const b = find(path)
    return b ? loadBlob(b) : Promise.reject(new Error(`LivLiv: ${path} is not among the files`))
  }
  let keyforms: KeyformFile | undefined
  const kf = model.keyforms ? find(model.keyforms) : undefined  // read only within its limit (format.ts LIMITS)
  if (kf && kf.size <= ZIP_LIMITS.keyforms) keyforms = await kf.text().then((t) => JSON.parse(t) as KeyformFile).catch(() => undefined)
  if (model.keyforms && !keyforms) console.warn(`LivLiv: ${model.keyforms} is missing or unreadable; the character plays on the rig alone`)
  return { model, image, keyforms }
}
