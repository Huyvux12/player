// @livliv/player/body: characters that aren't LivLiv models, on the surface of Player. A Body draws one (a PNGTuber's
// pictures: @livliv/player/png; a VRM: @livliv/player/vrm; or your own); the BodyPlayer gives it what a LivLiv model gets
// from Player: the idle motion, expressions, actions and drivers, so lip sync (@livliv/player/voice) and face tracking
// (@livliv/player/tracking) work for it the same way. Each frame the pose is put together as Player does it (your params,
// the idle motion, the drivers, actions, expressions); the Body turns it into its own picture.
import { ActionPlayer, type ActionId } from './runtime/actions'
import { pickLabel, uiLang, type Labels } from './runtime/format'
import { PARAM_RANGES, defaultParams, type Params } from './runtime/params'
import { Idle, type Seen } from './follow'
import type { Driver, Frame, Host, View } from './index'

/** an expression a Body can show: `labels` its names by language (BCP 47 tag -> name), `label` the one to fall back on */
export interface BodyExpression { id: string; label: string; labels?: Labels }

/** one frame's pose, as a Body draws it: the params, the picture's move (x, y shares of the canvas, y up; s a scale)
 *  and each expression's weight (0..1, eased) */
export interface Pose { params: Params; move: { x: number; y: number; s: number }; expr: Record<string, number> }

export interface Body {
  /** what kind of character it draws ('png', 'vrm', ...): BodyInfo.format */
  readonly format: string
  /** optional: called before load with the canvas it will draw on; throw if it cannot draw there (the canvas already has
   *  another kind of context), and load() rejects with that */
  attach?(canvas: HTMLCanvasElement): void
  /** loads from its files (by file name); its name and the expressions it can show. If it rejects, the character before
   *  must stay as it is */
  load(files: Map<string, Blob>): Promise<{ name: string; expressions: BodyExpression[]; meta?: BodyMeta }>
  /** draws the pose into the canvas, w × h device pixels, dt seconds after the last frame */
  render(canvas: HTMLCanvasElement, pose: Pose, w: number, h: number, dt: number): void
  /** where the head is, in shares of the canvas (from the top left) and its radii */
  head(): { x: number; y: number; rx: number; ry: number }
  dispose(): void
}

/** who made a body character and under what terms, as its file says */
export interface BodyMeta { author?: { name: string } | null; license?: { id?: string; url?: string } | null }

/** a loaded body character */
export interface BodyInfo {
  name: string
  /** the Body's format: 'png', 'vrm', ... */
  format: string
  /** what setExpression() takes (smile is always there: a param, not an expression) */
  expressions: { id: string; label: string; labels: Labels }[]
  /** what the file says about itself, where it does: a VRM's author and terms (VrmTerms). null otherwise */
  meta: BodyMeta | null
}

/** its files: a URL (one file, a .vrm say), a File / Blob, a FileList / File[], or a map or object of file name -> Blob
 *  or URL (`{ closed: 'me-closed.png', open: 'me-open.png' }`). Files are known by their name, without folders */
export type BodySource = string | URL | Blob | FileList | Iterable<File> | Map<string, Blob | string> | Record<string, Blob | string>

export interface BodyPlayerOptions {
  /** move by itself: breathe, blink, sway, look around (default true) */
  idle?: boolean
  /** the eyes and head follow the pointer anywhere on the page ('page', the default), over the canvas, or not */
  followPointer?: 'page' | 'canvas' | false
  /** drawing-buffer pixels per CSS pixel at most (default 2) */
  maxPixelRatio?: number
  /** start the frame loop at once (default true) */
  autoplay?: boolean
  /** the language expression names are picked in (default the browser's) */
  lang?: string
}

/** the most a body's files may hold in all (a VRM is usually 5-50 MB) */
export const BODY_LIMIT = 256 * 2 ** 20

const SMILE: Labels = { en: 'Smile', zh: '笑', 'zh-Hant': '笑', ja: '笑顔' }
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** Plays a character a Body draws, with the API of Player where it applies (no mark, no `puppet`, no `view.head`) */
export class BodyPlayer implements Host {
  readonly canvas: HTMLCanvasElement
  readonly body: Body
  /** your values for the pose and face (ranges in PARAM_RANGES). The player never changes them */
  readonly params: Params = defaultParams()
  idle: boolean
  followPointer: 'page' | 'canvas' | false
  /** x, y move the character by shares of the canvas (y up), zoom scales it (`head` is not used) */
  readonly view: View = { x: 0, y: 0, zoom: 1, head: false }
  maxPixelRatio: number
  readonly lang: string

  private info: BodyInfo | null = null
  private pose: Pose = { params: defaultParams(), move: { x: 0, y: 0, s: 1 }, expr: {} }
  private idler = new Idle()
  /** last frame's: a face tracker drove it, the mouth moved */
  private was = { tracked: false, mouth: 0 }
  private actions = new ActionPlayer()
  private drivers: Driver[] = []
  private expr: Record<string, number> = {}
  private smile = 0
  private time = 0
  private raf = 0
  private last = 0
  private visible = true
  private io?: IntersectionObserver
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  private frame: Frame & { move: { x: number; y: number; s: number } }

  constructor(canvas: HTMLCanvasElement, body: Body, options: BodyPlayerOptions = {}) {
    this.canvas = canvas
    this.body = body
    this.idle = options.idle ?? true
    this.followPointer = options.followPointer ?? 'page'
    this.maxPixelRatio = options.maxPixelRatio ?? 2
    this.lang = options.lang || uiLang()
    const P = this.pose.params
    this.frame = {
      params: P, dt: 0, time: 0, tracked: false, move: { x: 0, y: 0, s: 1 },
      add(o) {
        for (const [k, v] of Object.entries(o) as [keyof Params, number | undefined][]) {
          if (v) P[k] = clamp(P[k] + v, PARAM_RANGES[k][0], PARAM_RANGES[k][1])
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

  /** the loaded character (null before the first load) */
  get model(): BodyInfo | null { return this.info }
  get expressions() { return this.info?.expressions ?? [] }
  get playing() { return this.raf !== 0 }

  /** Loads a character from its files (see BodySource) in place of the one before (a failed load keeps it). Loads run one
   *  after another */
  load(source: BodySource): Promise<BodyInfo> {
    const run = this.queue.then(async () => {
      const stillHere = () => { if (this.disposed) throw new Error('LivLiv: the player was disposed') }
      stillHere()
      this.body.attach?.(this.canvas)
      const files = await filesOf(source)
      stillHere()
      const got = await this.body.load(files)
      if (this.disposed) this.body.dispose()  // disposed while it loaded: nothing of it may stay
      stillHere()
      const ex = [{ id: 'smile', label: '', labels: SMILE }, ...got.expressions.filter((e) => e.id !== 'smile')
        .map((e) => ({ id: e.id, label: e.label, labels: e.labels ?? { en: e.label } }))]
      this.info = { name: got.name, format: this.body.format, meta: got.meta ?? null,
        expressions: ex.map((e) => ({ id: e.id, label: pickLabel(e.labels, this.lang, e.label || e.id), labels: e.labels })) }
      this.expr = {}; this.smile = 0; this.pose.expr = {}
      if (!this.playing) this.draw(0)
      return this.info
    })
    this.queue = run.catch(() => {})
    return run
  }

  /** as Player's: an expression by id (smile is the smile param), easing over; null back to neutral */
  setExpression(id: string | null, weight = 1): boolean {
    if (id !== null && !this.expressions.some((e) => e.id === id)) return false
    const w = clamp(weight, 0, 1)
    this.smile = id === 'smile' ? w : 0
    this.expr = id === null || id === 'smile' ? {} : { [id]: w }
    return true
  }

  act(action: ActionId) { this.actions.play(action) }
  lookAt(x: number | null, y = 0) {
    this.idler.lookAt(this.seen(), x === null ? null : clamp(x, -1, 1), clamp(y, -1, 1), this.canvas.clientWidth, this.canvas.clientHeight)
  }
  blink() { this.idler.blink(this.time) }

  use(driver: Driver): () => void {
    if (this.disposed) { driver.dispose?.(); return () => {} }  // as Player's: what started meanwhile does not stay on
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
  /** draws now at the canvas's current size */
  resize() { this.draw(0) }
  /** the current frame as a PNG data URL */
  snapshot(): string { this.draw(0); return this.canvas.toDataURL('image/png') }

  dispose() {
    if (this.disposed) return
    this.pause()
    this.disposed = true
    removeEventListener('pointermove', this.onMove)
    document.removeEventListener('pointerleave', this.onLeave)
    this.io?.disconnect()
    for (const d of this.drivers.splice(0)) d.dispose?.()
    this.body.dispose()
    this.info = null
  }

  private draw(dt: number) {
    if (!this.info) return
    this.time += dt
    const P = this.pose.params, f = this.frame
    this.idler.shown(P)
    Object.assign(P, this.params)
    if (this.idle) {
      this.idler.apply(P, this.time, dt, { busy: this.actions.busy || this.was.mouth > 0.05, tracked: this.was.tracked,
        faceFree: !this.smile && !Object.values(this.pose.expr).some((v) => v > 0.02) })
    }
    Object.assign(f, { dt, time: this.time, tracked: false })
    Object.assign(f.move, { x: 0, y: 0, s: 1 })
    for (const d of this.drivers) d.update(f, this)
    this.was = { tracked: f.tracked, mouth: P.mouthOpen }
    const A = this.actions
    f.add(A.update(dt))
    if (this.smile) P.smile = Math.max(P.smile, this.smile)
    if (A.awayW) for (const [k, v] of Object.entries(A.awayPose(this.time)) as [keyof Params, number][]) P[k] += (v - P[k]) * A.awayW
    for (const k of Object.keys(P) as (keyof Params)[]) P[k] = clamp(P[k], PARAM_RANGES[k][0], PARAM_RANGES[k][1])
    // expressions ease in and out; dozing hides them
    const E = this.pose.expr
    for (const k of Object.keys(this.expr)) if (!(k in E)) E[k] = 0
    for (const k of Object.keys(E)) E[k] += ((this.expr[k] ?? 0) * (1 - A.awayW) - E[k]) * Math.min(1, dt * 8)
    const V = this.view
    this.pose.move = { x: f.move.x + V.x, y: f.move.y + A.y + V.y, s: f.move.s * V.zoom }
    const dpr = Math.min(this.maxPixelRatio, window.devicePixelRatio || 1)
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr)
    if (w >= 2 && h >= 2) this.body.render(this.canvas, this.pose, w, h, dt)
  }

  /** the body's head in the terms the idle's pointAt reads a puppet in (its canvas shares as clip space) */
  private seen(): Seen {
    const hd = this.info ? this.body.head() : { x: 0.5, y: 0.3, rx: 0.15, ry: 0.12 }
    return { model: { anchors: { head: { cx: 2 * hd.x - 1, cy: 2 * hd.y - 1, rx: 2 * hd.rx, ry: 2 * hd.ry } } } as Seen['model'], lastView: [1, 1, 0, 0, 2, 2] }
  }
  private onMove = (e: PointerEvent) => {
    if (!this.followPointer) return
    const r = this.canvas.getBoundingClientRect()
    const inside = !(e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
    this.idler.pointer(this.seen(), e.clientX - r.left, e.clientY - r.top, r.width, r.height, this.followPointer === 'page' || inside)
  }
  private onLeave = () => this.idler.leave()
}

/** a body's files by name, URLs fetched */
async function filesOf(source: BodySource): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>()
  let total = 0
  const add = async (key: string, v: Blob | string) => {
    const name = key.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'file'
    let b: Blob
    if (typeof v === 'string') {
      const url = new URL(v, document.baseURI).href
      const r = await fetch(url).catch(() => { throw new Error(`LivLiv: could not load ${url}: unreachable, or on another origin that sends no CORS header`) })
      if (!r.ok) throw new Error(`LivLiv: could not load ${url} (HTTP ${r.status})`)
      b = await r.blob()
    } else b = v
    if ((total += b.size) > BODY_LIMIT) throw new Error(`LivLiv: the files are larger than ${BODY_LIMIT} bytes`)
    out.set(name, b)
  }
  if (typeof source === 'string' || source instanceof URL) {
    const u = new URL(String(source), document.baseURI)
    await add(decodeURIComponent(u.pathname), u.href)
  } else if (source instanceof Blob) await add((source as File).name || 'file', source)
  else if (source instanceof Map) for (const [k, v] of source) await add(k, v)
  else if (Symbol.iterator in source) for (const f of source as Iterable<File>) await add(f.name, f)
  else for (const [k, v] of Object.entries(source)) await add(k, v)
  return out
}
