// @livliv/player/vrm: a VRM (the open 3D avatar format: VRoid and others) on a BodyPlayer (@livliv/player/body), drawn with
// three.js and @pixiv/three-vrm, which the page installs (optional peer dependencies) and which load only here. The
// shared params become its pose: the head and neck turn and tilt (angleX / Y / Z), the spine sways (bodyX / Z), the
// eyes blink (eyeLOpen / ROpen) and look (eyeBallX / Y), the mouth takes the visemes (mouthOpen with its vowel: aa open,
// ee wide, ou round), the face its expressions (happy with smile; angry, sad, relaxed, surprised); its hair and clothes
// swing by the model's own spring bones. Framed from the head down to the hips, arms down.
import type * as T from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { Body, BodyExpression, Pose } from './body'

const FEELINGS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const
const LABELS: Record<(typeof FEELINGS)[number], Record<string, string>> = {
  happy: { en: 'Happy', zh: '开心', 'zh-Hant': '開心', ja: '喜び' },
  angry: { en: 'Angry', zh: '生气', 'zh-Hant': '生氣', ja: '怒り' },
  sad: { en: 'Sad', zh: '难过', 'zh-Hant': '難過', ja: '悲しい' },
  relaxed: { en: 'Relaxed', zh: '放松', 'zh-Hant': '放鬆', ja: 'リラックス' },
  surprised: { en: 'Surprised', zh: '惊讶', 'zh-Hant': '驚訝', ja: '驚き' },
}
const D = Math.PI / 180

export class VrmBody implements Body {
  readonly format = 'vrm'
  private THREE!: typeof T
  private vrm: VRM | null = null
  private scene!: T.Scene
  private camera!: T.PerspectiveCamera
  private renderer: T.WebGLRenderer | null = null
  private bones: Partial<Record<'head' | 'neck' | 'spine' | 'chest', T.Object3D>> = {}
  /** the framing: the world height shown (m), and its center */
  private frame = { height: 1, y: 1 }
  private has = new Set<string>()
  private canvas: HTMLCanvasElement | null = null
  private headAt = { x: 0.5, y: 0.25 }

  attach(canvas: HTMLCanvasElement) {
    // the attributes render() gives three.js, which then finds this same context
    if (!canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true })) {
      throw new Error('LivLiv: a VRM needs WebGL2: this browser has none, or this canvas already draws in 2D (a PNGTuber)')
    }
  }

  async load(files: Map<string, Blob>) {
    const entry = [...files].find(([n]) => /\.(vrm|glb)$/i.test(n))
    if (!entry) throw new Error('LivLiv: no .vrm file among the files')
    const [THREE, { GLTFLoader }, { VRMLoaderPlugin, VRMUtils }] = await Promise.all([
      import('three'), import('three/examples/jsm/loaders/GLTFLoader.js'), import('@pixiv/three-vrm')]).catch((e) => {
      throw new Error(`LivLiv: a VRM needs the three and @pixiv/three-vrm packages (${(e as Error).message})`)
    })
    this.THREE = THREE
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const url = URL.createObjectURL(entry[1])
    let gltf
    try {
      gltf = await loader.loadAsync(url)
    } catch (e) {
      throw new Error(`LivLiv: ${entry[0]} is not a VRM this player can read (${(e as Error).message})`)
    } finally {
      URL.revokeObjectURL(url)
    }
    const vrm = gltf.userData.vrm as VRM | undefined
    if (!vrm) {
      VRMUtils.deepDispose(gltf.scene)
      throw new Error(`LivLiv: ${entry[0]} is a glTF without VRM data`)
    }
    // the new character, apart from the one shown (a failed load leaves that on the canvas): it takes over at the end
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.rotateVRM0(vrm)  // VRM 0.x faces the other way
    vrm.scene.traverse((o) => { o.frustumCulled = false })
    const h = vrm.humanoid
    const bones: typeof this.bones = {}
    for (const b of ['head', 'neck', 'spine', 'chest'] as const) bones[b] = h.getNormalizedBoneNode(b) ?? undefined
    // arms down from the T pose, a little forward
    const lu = h.getNormalizedBoneNode('leftUpperArm'), ru = h.getNormalizedBoneNode('rightUpperArm')
    if (lu) lu.rotation.set(0, 0, -1.2)
    if (ru) ru.rotation.set(0, 0, 1.2)
    const ll = h.getNormalizedBoneNode('leftLowerArm'), rl = h.getNormalizedBoneNode('rightLowerArm')
    if (ll) ll.rotation.set(0, -0.25, 0)
    if (rl) rl.rotation.set(0, 0.25, 0)
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false
    vrm.update(0)

    const scene = new THREE.Scene()
    scene.add(vrm.scene)
    const light = new THREE.DirectionalLight(0xffffff, Math.PI)
    light.position.set(1, 1, 1).normalize()
    scene.add(light, new THREE.AmbientLight(0xffffff, 0.6))
    // the head's top to the hips: what a LivLiv character's canvas shows of a person
    const at = (b: 'head' | 'hips') => { const v = new THREE.Vector3(); h.getNormalizedBoneNode(b)?.getWorldPosition(v); return v }
    const head = at('head'), hips = at('hips')
    const top = head.y + 0.2, bottom = hips.y
    const has = new Set((vrm.expressionManager?.expressions ?? []).map((e) => e.expressionName))
    const meta = vrm.meta as { name?: string; title?: string } | undefined
    const expressions: BodyExpression[] = FEELINGS.filter((f) => f !== 'happy' && has.has(f)).map((f) => ({ id: f, label: LABELS[f].en, labels: LABELS[f] }))
    if (has.has('happy')) expressions.unshift({ id: 'happy', label: LABELS.happy.en, labels: LABELS.happy })
    const name = (meta?.name || meta?.title || entry[0].replace(/\.(vrm|glb)$/i, '')).slice(0, 200)

    const old = this.vrm
    this.vrm = vrm
    this.scene = scene
    this.bones = bones
    this.has = has
    this.frame = { height: Math.max(0.1, top - bottom), y: (top + bottom) / 2 }
    this.camera = new THREE.PerspectiveCamera(20, 2 / 3, 0.05, 30)
    this.place(2 / 3)  // render() gives it the canvas's aspect
    if (old) VRMUtils.deepDispose(old.scene)
    return { name, expressions }
  }

  /** the camera where the framing fits the canvas's aspect */
  private place(aspect: number) {
    const c = this.camera, half = this.frame.height / 2
    // tall enough for the height, wide enough for the shoulders and arms on narrow canvases
    const dist = Math.max(half, 0.3 / aspect) / Math.tan((c.fov * D) / 2)
    c.aspect = aspect
    c.position.set(0, this.frame.y, dist)
    c.lookAt(0, this.frame.y, 0)
    c.updateProjectionMatrix()
  }

  render(canvas: HTMLCanvasElement, { params: P, move, expr }: Pose, w: number, h: number, dt: number) {
    const THREE = this.THREE, vrm = this.vrm
    if (!vrm) return
    if (!this.renderer || this.canvas !== canvas) {
      this.renderer?.dispose()
      this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true })
      this.renderer.setClearColor(0x000000, 0)
      this.canvas = canvas
    }
    if (canvas.width !== w || canvas.height !== h) this.renderer.setSize(w, h, false)
    if (this.camera.aspect !== w / h) this.place(w / h)  // a new character's camera, on a canvas already this size too
    const b = this.bones
    // the head turns most, the neck some (yaw: to the screen's right; pitch: up; roll: toward the screen's left)
    b.neck?.rotation.set(-P.angleY * D * 0.35, P.angleX * D * 0.35, -P.angleZ * D * 0.35)
    b.head?.rotation.set(-P.angleY * D * 0.65, P.angleX * D * 0.65, -P.angleZ * D * 0.65)
    b.spine?.rotation.set(0, P.bodyX * D * 0.8, -P.bodyZ * D * 0.8)
    b.chest?.rotation.set(-(P.breath - 0.5) * 0.02, 0, 0)
    vrm.scene.position.set(move.x * this.frame.height * 0.5, move.y * this.frame.height, 0)
    vrm.scene.scale.setScalar(move.s)
    const em = vrm.expressionManager
    if (em) {
      const set = (n: string, v: number) => { if (this.has.has(n)) em.setValue(n, Math.max(0, Math.min(1, v))) }
      set('blinkLeft', 1 - P.eyeLOpen); set('blinkRight', 1 - P.eyeROpen)
      const o = P.mouthOpen, v = P.vowel
      set('aa', o * (1 - Math.abs(v) * 0.6)); set('ee', o * Math.max(0, v) * 0.7); set('ou', o * Math.max(0, -v) * 0.7)
      // the smile param is a small one (the idle motion's, the face tracker's): half the model's happy, which often
      // closes the eyes
      set('happy', Math.max(P.smile * 0.5, expr.happy ?? 0))
      for (const f of FEELINGS) if (f !== 'happy') set(f, expr[f] ?? 0)
    }
    if (vrm.lookAt) { vrm.lookAt.yaw = P.eyeBallX * 25; vrm.lookAt.pitch = P.eyeBallY * 15 }
    vrm.update(dt)
    this.renderer.render(this.scene, this.camera)
    // where the head is now, for the pointer
    const p = new THREE.Vector3()
    b.head?.getWorldPosition(p)
    p.y += 0.06
    p.project(this.camera)
    this.headAt = { x: (p.x + 1) / 2, y: (1 - p.y) / 2 }
  }

  head() { return { ...this.headAt, rx: 0.14, ry: 0.1 } }

  dispose() {
    this.renderer?.dispose(); this.renderer = null; this.canvas = null
    const vrm = this.vrm
    this.vrm = null
    if (vrm) void import('@pixiv/three-vrm').then(({ VRMUtils }) => VRMUtils.deepDispose(vrm.scene))
  }
}
