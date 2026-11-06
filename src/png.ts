// @livliv/player/png: a PNGTuber on a BodyPlayer (@livliv/player/body). A few pictures of the character, one shown at a
// time: the mouth closed or open (the voice, the microphone), the eyes closed when it blinks (optional, and with the
// mouth open too). The picture sways with the head, tilts, breathes and hops with the voice, standing on the bottom of
// the canvas. Files by name (any image the browser decodes): closed, open, blink, blink-open, and name.txt.
import type { Body, Pose } from './body'
import { LivLivError } from './errors'

export const PNG_SLOTS = [
  { id: 'closed', label: 'Mouth closed', need: true },
  { id: 'open', label: 'Mouth open', need: true },
  { id: 'blink', label: 'Eyes closed', need: false },
  { id: 'blink-open', label: 'Eyes closed, mouth open', need: false },
] as const
export type PngSlot = (typeof PNG_SLOTS)[number]['id']

/** a picture's sides at most (px), and the pictures' pixels in all */
const MAX_SIDE = 8192, MAX_PIXELS = 64 * 2 ** 20

export class PngBody implements Body {
  readonly format = 'png'
  private pics: Partial<Record<PngSlot, ImageBitmap>> = {}
  private g: CanvasRenderingContext2D | null = null

  attach(canvas: HTMLCanvasElement) {
    this.g = canvas.getContext('2d')
    if (!this.g) throw new LivLivError('canvas-in-use', 'LivLiv: this canvas already draws with WebGL (a Player or a VRM): a PNGTuber needs a canvas of its own')
  }

  async load(files: Map<string, Blob>) {
    // the new pictures apart from the ones shown: anything wrong with them leaves those on the canvas
    const pics: typeof this.pics = {}
    let name = 'PNGTuber'
    try {
      let pixels = 0
      for (const [file, blob] of files) {
        const slot = PNG_SLOTS.find((s) => file.replace(/\.[^.]*$/, '').toLowerCase() === s.id)?.id
        if (!slot) continue
        const b = await createImageBitmap(blob).catch(() => { throw new LivLivError('invalid', `LivLiv: ${file} is not an image this browser can read`) })
        pics[slot] = b
        if (b.width > MAX_SIDE || b.height > MAX_SIDE || (pixels += b.width * b.height) > MAX_PIXELS) throw new LivLivError('too-large', `LivLiv: ${file} is too large (${b.width} x ${b.height})`)
      }
      if (!pics.closed || !pics.open) throw new LivLivError('missing-file', 'LivLiv: a PNGTuber needs at least the closed and the open picture')
      const txt = files.get('name.txt')
      if (txt) name = (await txt.slice(0, 200).text()).trim() || name
    } catch (e) {
      for (const b of Object.values(pics)) b?.close()
      throw e
    }
    this.dispose()
    this.pics = pics
    return { name, expressions: [] }
  }

  render(canvas: HTMLCanvasElement, { params: P, move }: Pose, w: number, h: number) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    const g = (this.g ??= canvas.getContext('2d'))  // attach() has told the page if it cannot have one
    if (!g) return
    g.clearRect(0, 0, w, h)
    const x = this.pics
    if (!x.closed || !x.open) return
    const talk = P.mouthOpen > 0.18, shut = Math.min(P.eyeLOpen, P.eyeROpen) < 0.35
    const img = shut && talk ? x['blink-open'] ?? x.blink ?? x.open : shut ? x.blink ?? x.closed : talk ? x.open : x.closed
    // fitted into the canvas, standing on its bottom; the head's turn and the body's sway move it sideways, its nod and
    // breath up a little, the voice's hop (move.y, y up) more; it tilts about its feet
    const k = Math.min(w / img.width, h / img.height) * move.s, dw = img.width * k, dh = img.height * k
    const dx = (P.angleX / 30) * 0.025 * w + (P.bodyX / 10) * 0.015 * w + move.x * w * 0.5
    const dy = (P.angleY / 30) * 0.012 * h + P.breath * 0.006 * h + move.y * h * 0.5
    g.save()
    g.translate(w / 2 + dx, h - dy)
    g.rotate(((P.angleZ * 0.25 + P.bodyZ * 0.4) * Math.PI) / 180)
    g.drawImage(img, -dw / 2, -dh, dw, dh)
    g.restore()
  }

  /** a picture's head: near the top, about the middle */
  head() { return { x: 0.5, y: 0.26, rx: 0.16, ry: 0.13 } }

  dispose() { for (const b of Object.values(this.pics)) b?.close(); this.pics = {} }
}
