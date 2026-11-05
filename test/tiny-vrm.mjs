// A tiny VRM 1.0 for the tests, made here so the repository needs no one else's model: a humanoid skeleton (the bones
// VRM requires, plus neck and chest), a box for the head and one for the body, and the expressions the player sets
// (happy, sad, aa, ee, ou, blinkLeft, blinkRight; no morphs behind them), and looking done by expressions. Returns the
// .vrm (GLB) bytes. spec 0 writes it as VRM 0.x, mirrored as those files are (facing -Z, the left arm at -X). unit scales
// every length, as an exporter's unit setting can. A file can be spoiled for the tests of what the player refuses:
// noMesh (a skeleton alone), draco (says it is compressed), outsideImage (a picture by URL), bigImage (a PNG header
// claiming 9000 x 9000 px)
export function tinyVrm({ spec = 1, unit = 1, noMesh = false, draco = false, outsideImage = '', bigImage = false } = {}) {
  const mirror = spec === 0 ? -1 : 1
  // [bone, parent, translation]
  const bones = [
    ['hips', -1, [0, 1, 0]], ['spine', 'hips', [0, 0.12, 0]], ['chest', 'spine', [0, 0.15, 0]], ['neck', 'chest', [0, 0.22, 0]],
    ['head', 'neck', [0, 0.08, 0]],
    ['leftUpperArm', 'chest', [0.18, 0.18, 0]], ['leftLowerArm', 'leftUpperArm', [0.25, 0, 0]], ['leftHand', 'leftLowerArm', [0.22, 0, 0]],
    ['rightUpperArm', 'chest', [-0.18, 0.18, 0]], ['rightLowerArm', 'rightUpperArm', [-0.25, 0, 0]], ['rightHand', 'rightLowerArm', [-0.22, 0, 0]],
    ['leftUpperLeg', 'hips', [0.09, -0.05, 0]], ['leftLowerLeg', 'leftUpperLeg', [0, -0.42, 0]], ['leftFoot', 'leftLowerLeg', [0, -0.42, 0]],
    ['rightUpperLeg', 'hips', [-0.09, -0.05, 0]], ['rightLowerLeg', 'rightUpperLeg', [0, -0.42, 0]], ['rightFoot', 'rightLowerLeg', [0, -0.42, 0]],
  ]
  const index = Object.fromEntries(bones.map(([n], i) => [n, i]))
  const nodes = bones.map(([name, , t]) => ({ name, translation: [t[0] * mirror * unit, t[1] * unit, t[2] * unit], children: [] }))
  bones.forEach(([n, p]) => { if (p !== -1) nodes[index[p]].children.push(index[n]) })
  // the boxes: the head's on the head bone, the body's (scaled) on the chest
  if (!noMesh) {
    nodes.push({ name: 'headBox', mesh: 0, translation: [0, 0.1 * unit, 0], scale: [0.2 * unit, 0.22 * unit, 0.2 * unit] })
    nodes.push({ name: 'bodyBox', mesh: 1, translation: [0, -0.05 * unit, 0], scale: [0.36 * unit, 0.5 * unit, 0.2 * unit] })
    nodes[index.head].children.push(nodes.length - 2)
    nodes[index.chest].children.push(nodes.length - 1)
  }
  for (const n of nodes) if (!n.children?.length) delete n.children

  // a unit box: 8 corners, 12 triangles
  const P = new Float32Array([-.5, -.5, -.5, .5, -.5, -.5, .5, .5, -.5, -.5, .5, -.5, -.5, -.5, .5, .5, -.5, .5, .5, .5, .5, -.5, .5, .5])
  const I = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5])
  // a PNG's first bytes, claiming a picture far too big (the player reads the size, never decodes it)
  const pngHead = new Uint8Array(24)
  pngHead.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(pngHead.buffer).setUint32(16, 9000); new DataView(pngHead.buffer).setUint32(20, 9000)
  const pad = (4 - (I.byteLength % 4)) % 4
  const bin = new Uint8Array(P.byteLength + I.byteLength + pad + (bigImage ? pngHead.length : 0))
  bin.set(new Uint8Array(P.buffer), 0)
  bin.set(new Uint8Array(I.buffer), P.byteLength)
  if (bigImage) bin.set(pngHead, P.byteLength + I.byteLength + pad)
  const prim = (material) => ({ attributes: { POSITION: 0 }, indices: 1, material })
  const empty = {}
  const range = { inputMaxValue: 90, outputScale: 1 }
  const lookAt = { type: 'expression', rangeMapHorizontalInner: range, rangeMapHorizontalOuter: range, rangeMapVerticalDown: range, rangeMapVerticalUp: range }
  const curve = { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 90, yRange: 1 }
  const VRM0 = {
    exporterVersion: 'LivLiv Player tests', specVersion: '0.0',
    meta: { title: 'Tiny 0', author: 'LivLiv Player tests', allowedUserName: 'Everyone', violentUssageName: 'Disallow', sexualUssageName: 'Disallow', commercialUssageName: 'Allow', licenseName: 'CC0' },
    humanoid: { humanBones: bones.map(([bone]) => ({ bone, node: index[bone] })) },
    firstPerson: { lookAtTypeName: 'BlendShape', lookAtHorizontalInner: curve, lookAtHorizontalOuter: curve, lookAtVerticalDown: curve, lookAtVerticalUp: curve },
    blendShapeMaster: { blendShapeGroups: [['joy', 'Joy'], ['sorrow', 'Sorrow'], ['a', 'A'], ['e', 'E'], ['u', 'U'], ['blink', 'Blink'], ['lookup', 'LookUp'], ['lookdown', 'LookDown'], ['lookleft', 'LookLeft'], ['lookright', 'LookRight']].map(([presetName, name]) => ({ name, presetName, binds: [] })) },
  }
  const VRM1 = {
    specVersion: '1.0',
    meta: { name: 'Tiny', version: '1', authors: ['LivLiv Player tests'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', commercialUsage: 'personalNonProfit' },
    humanoid: { humanBones: Object.fromEntries(bones.map(([n]) => [n, { node: index[n] }])) },
    lookAt,
    expressions: { preset: { happy: empty, sad: empty, aa: empty, ee: empty, ou: empty, blinkLeft: empty, blinkRight: empty, lookUp: empty, lookDown: empty, lookLeft: empty, lookRight: empty }, custom: { Surprised: empty, Wink: empty } },
  }
  const compressed = draco ? ['KHR_draco_mesh_compression'] : []
  const json = {
    asset: { version: '2.0', generator: 'LivLiv Player tests' },
    extensionsUsed: [spec === 0 ? 'VRM' : 'VRMC_vrm', ...compressed],
    ...(compressed.length ? { extensionsRequired: compressed } : {}),
    ...(outsideImage ? { images: [{ uri: outsideImage }] } : bigImage ? { images: [{ bufferView: 2, mimeType: 'image/png' }] } : {}),
    scene: 0, scenes: [{ nodes: [index.hips] }], nodes,
    ...(noMesh ? {} : { meshes: [{ primitives: [prim(0)] }, { primitives: [prim(1)] }] }),
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [1, 0.82, 0.74, 1], metallicFactor: 0, roughnessFactor: 1 } },
      { pbrMetallicRoughness: { baseColorFactor: [0.3, 0.45, 0.9, 1], metallicFactor: 0, roughnessFactor: 1 } },
    ],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: P.byteLength, target: 34962 },
      { buffer: 0, byteOffset: P.byteLength, byteLength: I.byteLength, target: 34963 },
      ...(bigImage ? [{ buffer: 0, byteOffset: P.byteLength + I.byteLength + pad, byteLength: pngHead.length }] : []),
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: I.length, type: 'SCALAR' },
    ],
    extensions: spec === 0 ? { VRM: VRM0 } : { VRMC_vrm: VRM1 },
  }
  const text = new TextEncoder().encode(JSON.stringify(json))
  const jlen = text.length + ((4 - (text.length % 4)) % 4)
  const glb = new Uint8Array(12 + 8 + jlen + 8 + bin.byteLength)
  const v = new DataView(glb.buffer)
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, glb.length, true)
  v.setUint32(12, jlen, true); v.setUint32(16, 0x4e4f534a, true)
  glb.fill(0x20, 20, 20 + jlen); glb.set(text, 20)
  v.setUint32(20 + jlen, bin.byteLength, true); v.setUint32(24 + jlen, 0x004e4942, true)
  glb.set(bin, 28 + jlen)
  return glb
}
