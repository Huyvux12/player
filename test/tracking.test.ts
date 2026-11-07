// Numerical regression tests for the camera-matrix -> player-parameter boundary, not a substitute for real-camera checks.
import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { FaceTracker } from '../src/runtime/tracking'

// MediaPipe's column-major, Y-up face transform: Rz(roll) Ry(yaw), with no pitch.
// Positive roll moves the top of the face toward camera-image left. Positive player angleZ moves it screen-right
// (the player's model coordinates are Y-down), so roll and yaw need different signs at the parameter boundary.
function matrix(yaw: number, roll: number) {
  const y = yaw * Math.PI / 180, z = roll * Math.PI / 180
  const cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z)
  return [cz * cy, sz * cy, -sy, 0, -sz, cz, 0, 0, cz * sy, sz * sy, cy, 0, 0, 0, -45, 1]
}

function camera(t: TestContext, mirror: boolean) {
  // Only the video element and optional light-check canvas need a DOM; no camera, model or GPU is started here.
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: (tag: string) => tag === 'video' ? { readyState: 2, currentTime: 0 } : { getContext: () => null },
  } })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  let now = 0, pose = matrix(0, 0)
  t.mock.method(performance, 'now', () => now)
  const tracker = new FaceTracker()
  tracker.setMirror(mirror)
  tracker.lm = { detectForVideo: () => ({
    faceLandmarks: [[]], facialTransformationMatrixes: [{ data: pose }], faceBlendshapes: [],
  }) } as unknown as NonNullable<FaceTracker['lm']>
  const read = (yaw: number, roll: number, frames = 1) => {
    pose = matrix(yaw, roll)
    for (let i = 0; i < frames; i++) {
      now += 1000 / 30
      Object.assign(tracker.video, { currentTime: now / 1000 })
      assert.equal(tracker.poll(), true)
    }
    return { ...tracker.target }
  }
  return { tracker, read }
}

const near = (value: number | undefined, expected: number, tolerance = 1e-6) =>
  assert.ok(value !== undefined && Math.abs(value - expected) < tolerance, `${value} ≈ ${expected}`)

describe('camera roll mapping', () => {
  for (const mirror of [true, false]) {
    for (const direction of [-1, 1]) {
      it(`mirror=${mirror}, rotation sign ${direction}: roll has the screen-coordinate sign; yaw is preserved`, (t) => {
        const { read } = camera(t, mirror)
        const p = read(direction * 10, direction * 20)
        near(p.angleX, (mirror ? -13 : 13) * direction)
        near(p.bodyX, (mirror ? -2.6 : 2.6) * direction)
        near(p.angleZ, (mirror ? 20 : -20) * direction)
      })
    }

    it(`mirror=${mirror}: a nonzero calibrated pose remains centered, then tracks relative roll and yaw`, (t) => {
      const { tracker, read } = camera(t, mirror)
      read(4, 10, 20)
      tracker.calibrate()
      const centered = read(4, 10)
      near(centered.angleZ, 0)
      near(centered.angleX, 0)
      const moved = read(14, 22, 90)
      near(moved.angleX, mirror ? -13 : 13, 0.1)
      near(moved.angleZ, mirror ? 12 : -12, 0.1)
    })

    it(`mirror=${mirror}: toggling mirror keeps the calibrated center and reverses relative roll and yaw`, (t) => {
      const { tracker, read } = camera(t, mirror)
      read(4, 10, 20)
      tracker.calibrate()
      tracker.setMirror(!mirror)
      const centered = read(4, 10)
      near(centered.angleZ, 0)
      near(centered.angleX, 0)
      const moved = read(14, 22, 90)
      near(moved.angleX, mirror ? 13 : -13, 0.1)
      near(moved.angleZ, mirror ? -12 : 12, 0.1)
    })
  }
})
