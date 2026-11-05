// A tiny VRM 1.0 for the tests, made here so the repository needs no one else's model: a humanoid skeleton (the bones
// VRM requires, plus neck and chest), a box for the head and one for the body, and the expressions the player sets
// (happy, sad, aa, ee, ou, blinkLeft, blinkRight; no morphs behind them). Returns the .vrm (GLB) bytes.
export function tinyVrm() {
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
  const nodes = bones.map(([name, , t]) => ({ name, translation: t, children: [] }))
  bones.forEach(([n, p]) => { if (p !== -1) nodes[index[p]].children.push(index[n]) })
  // the boxes: the head's on the head bone, the body's (scaled) on the chest
  nodes.push({ name: 'headBox', mesh: 0, translation: [0, 0.1, 0], scale: [0.2, 0.22, 0.2] })
  nodes.push({ name: 'bodyBox', mesh: 1, translation: [0, -0.05, 0], scale: [0.36, 0.5, 0.2] })
  nodes[index.head].children.push(nodes.length - 2)
  nodes[index.chest].children.push(nodes.length - 1)
  for (const n of nodes) if (!n.children?.length) delete n.children

  // a unit box: 8 corners, 12 triangles
  const P = new Float32Array([-.5, -.5, -.5, .5, -.5, -.5, .5, .5, -.5, -.5, .5, -.5, -.5, -.5, .5, .5, -.5, .5, .5, .5, .5, -.5, .5, .5])
  const I = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5])
  const bin = new Uint8Array(P.byteLength + I.byteLength + ((4 - (I.byteLength % 4)) % 4))
  bin.set(new Uint8Array(P.buffer), 0)
  bin.set(new Uint8Array(I.buffer), P.byteLength)
  const prim = (material) => ({ attributes: { POSITION: 0 }, indices: 1, material })
  const empty = {}
  const json = {
    asset: { version: '2.0', generator: 'LivLiv Player tests' },
    extensionsUsed: ['VRMC_vrm'],
    scene: 0, scenes: [{ nodes: [index.hips] }], nodes,
    meshes: [{ primitives: [prim(0)] }, { primitives: [prim(1)] }],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [1, 0.82, 0.74, 1], metallicFactor: 0, roughnessFactor: 1 } },
      { pbrMetallicRoughness: { baseColorFactor: [0.3, 0.45, 0.9, 1], metallicFactor: 0, roughnessFactor: 1 } },
    ],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: P.byteLength, target: 34962 },
      { buffer: 0, byteOffset: P.byteLength, byteLength: I.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: I.length, type: 'SCALAR' },
    ],
    extensions: {
      VRMC_vrm: {
        specVersion: '1.0',
        meta: { name: 'Tiny', version: '1', authors: ['LivLiv Player tests'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', commercialUsage: 'corporation' },
        humanoid: { humanBones: Object.fromEntries(bones.map(([n]) => [n, { node: index[n] }])) },
        expressions: { preset: { happy: empty, sad: empty, aa: empty, ee: empty, ou: empty, blinkLeft: empty, blinkRight: empty } },
      },
    },
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
