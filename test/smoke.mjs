// Browser smoke test: every featured character in characters/ loaded and drawn by the built player (dist/) in headless
// Chromium (WebGL2 in software), with its mark, plus loading from files, a v3 package drawing like its v4, and
// refusing a newer format (see smoke.html); then the characters that aren't LivLiv models, a PNGTuber and a VRM
// (bodies.html).
//   npm run build && npm run test:browser
// Needs a Chromium for playwright-core once: npx playwright-core install chromium-headless-shell
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { crc32, deflateSync } from 'node:zlib'
import { tinyVrm } from './tiny-vrm.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const chars = join(root, 'characters')
if (!existsSync(join(root, 'dist/index.js'))) { console.error('smoke: build first (npm run build)'); process.exit(1) }
const ids = existsSync(chars) ? readdirSync(chars).filter((d) => statSync(join(chars, d)).isDirectory()).sort() : []
if (!ids.length) { console.error('smoke: no featured characters in characters/'); process.exit(1) }
/** each character's files, as paths inside its folder (the page loads them as a picked folder) */
const list = (dir, at = '') => readdirSync(join(dir, at), { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? list(dir, join(at, d.name)) : [join(at, d.name).split('\\').join('/')]))
const files = Object.fromEntries(ids.map((id) => [id, list(join(chars, id))]))

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' }
const vrm = tinyVrm()
/** an image bomb: a 9000 x 9000 PNG (all black, 80 KB), past the player's 8192 px a side */
function bombPng(side = 9000) {
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length), t = Buffer.concat([Buffer.from(type), data])
    b.writeUInt32BE(data.length, 0); t.copy(b, 4); b.writeUInt32BE(crc32(t), 8 + data.length)
    return b
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(side * (side + 1)))), chunk('IEND', Buffer.alloc(0))])
}
const bomb = bombPng()
const server = createServer((req, res) => {
  if (req.url === '/__tiny.vrm') { res.writeHead(200, { 'content-type': 'model/gltf-binary' }).end(vrm); return }
  if (req.url === '/__bomb.png') { res.writeHead(200, { 'content-type': 'image/png' }).end(bomb); return }
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
  const f = join(root, p)
  if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }).end(readFileSync(f))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
let failed = 0
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/test/smoke.html`)
  await page.waitForFunction(() => typeof window.run === 'function')
  const { out, fromFiles, newer, legacy, packaged } = await page.evaluate((a) => window.run(a), { ids, files })
  for (const r of out) {
    // the featured characters carry the LivLiv mark in the corner only: the player must draw it there and nowhere else
    const ok = !r.error && r.share > 0.05 && r.glError === 0 && r.watermark === 'LivLiv' && r.mark > 0.001 && r.outside < 0.0003 && r.noise < 0.0005
      && r.license === 'LicenseRef-LivLiv-Samples'
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.id.padEnd(6)} ${r.error ?? `${r.name} (${r.format}), ${r.expressions}, covers ${(r.share * 100).toFixed(1)} %, mark ${r.watermark} on ${(r.mark * 100).toFixed(2)} % (outside the corner ${(r.outside * 100).toFixed(2)} %, noise ${(r.noise * 100).toFixed(2)} %), ${r.ms} ms${r.glError ? `, GL error ${r.glError}` : ''}`}`)
  }
  const filesOk = !fromFiles.error && fromFiles.share > 0.05
  if (!filesOk) failed++
  console.log(`${filesOk ? 'ok  ' : 'FAIL'} from files: ${fromFiles.error ?? `${fromFiles.name}, covers ${(fromFiles.share * 100).toFixed(1)} %`}`)
  for (const k of packaged) {
    const ok = k.changed < 0.0005 && k.keys[0] === k.keys[1]
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${k.id}.livliv from a URL: ${(k.changed * 100).toFixed(2)} % of the pixels differ from its folder, keyforms ${k.keys.join(' / ')}`)
  }
  const legacyOk = !legacy.error && /^livemaker-puppet 3$/.test(legacy.format) && legacy.watermark === null && legacy.changed < 0.0005
  if (!legacyOk) failed++
  console.log(`${legacyOk ? 'ok  ' : 'FAIL'} v3 package: ${legacy.error ?? `${legacy.format}, ${(legacy.changed * 100).toFixed(2)} % of the pixels differ from its v4`}`)
  const newerOk = /update the player/.test(newer.message || '') && !!newer.kept
  if (!newerOk) failed++
  console.log(`${newerOk ? 'ok  ' : 'FAIL'} newer format refused: ${newer.message ?? newer.error} (kept: ${newer.kept})`)
  // hostile packages: refused with the model before kept; broken keyforms: played on the rig alone
  const kfId = ids.find((id) => JSON.parse(readFileSync(join(chars, id, 'model.json'), 'utf8')).files?.keyforms) ?? ids[0]
  const hostile = await page.evaluate(([a, b]) => window.runHostile(a, b), [ids[0], kfId])
  const why = { bomb: /too large/, path: /not an image path|not a path/, canvas: /canvas/, box: /box/, json: /not a model\.json/, layers: /layers/ }
  for (const [k, re] of Object.entries(why)) {
    const r = hostile[k], ok = !r.loaded && re.test(r.refused) && !!r.kept
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} refuses ${k}: ${r.loaded ? 'it loaded' : r.refused.slice(0, 110)} (kept: ${r.kept})`)
  }
  const kfOk = hostile.keyforms.loaded && hostile.keyforms.share > 0.05
  if (!kfOk) failed++
  console.log(`${kfOk ? 'ok  ' : 'FAIL'} broken keyforms: ${hostile.keyforms.refused ?? `${hostile.keyforms.name} plays on the rig alone`}`)

  // disposing while something runs (see runLifecycle)
  const life = await page.evaluate((id) => window.runLifecycle(id), ids[0])
  const lifeOk = /disposed/.test(life.load) && life.model === null && life.drawn === 0 && life.freed >= life.made && life.glError === 0
    && life.driver === 1 && !!life.again && life.mic === 'ended' && life.supported === true
  if (!lifeOk) failed++
  console.log(`${lifeOk ? 'ok  ' : 'FAIL'} dispose while running: load "${life.load}", ${life.made} textures made, ${life.freed} freed, drawn ${life.drawn}, GL error ${life.glError}, driver disposed ${life.driver}, a new player ${life.again}, microphone ${life.mic}`)

  // bodies: a PNGTuber shows each picture and follows the drivers; a VRM loads, draws and takes its expressions
  await page.goto(`http://127.0.0.1:${server.address().port}/test/bodies.html`)
  await page.waitForFunction(() => typeof window.runBodies === 'function')
  const { png, vrm: v, pngFailed, pngOnGl, vrmAgain, vrmOn2d } = await page.evaluate(() => window.runBodies())
  const is = (rgb, [r, g, b]) => Math.abs(rgb[0] - r) < 40 && Math.abs(rgb[1] - g) < 40 && Math.abs(rgb[2] - b) < 40
  const pngOk = !png.error && png.format === 'png' && is(png.shown.closed, [255, 0, 0]) && is(png.shown.open, [0, 255, 0])
    && is(png.shown.blink, [0, 0, 255]) && is(png.shown.blinkOpen, [255, 255, 0]) && png.tracked && png.angle > 0 && png.mouth > 0.3
  if (!pngOk) failed++
  console.log(`${pngOk ? 'ok  ' : 'FAIL'} PNGTuber: ${png.error ?? `pictures ${['closed', 'open', 'blink', 'blinkOpen'].map((k) => png.shown[k].join(',')).join(' / ')}, face tracked ${png.tracked} (turn ${png.angle.toFixed(2)}°), speech opens the mouth to ${png.mouth.toFixed(2)}`}`)
  const vrmOk = !v.error && v.format === 'vrm' && v.share > 0.02 && v.happy && v.smile && !v.unknown && v.tracked && v.head
    && ['Smile', 'Happy', 'Sad'].every((l) => v.expressions.includes(l))
  if (!vrmOk) failed++
  console.log(`${vrmOk ? 'ok  ' : 'FAIL'} VRM: ${v.error ?? `${v.name}, ${v.expressions.join(' / ')}, covers ${(v.share * 100).toFixed(1)} %, face tracked ${v.tracked}`}`)
  const pfOk = /needs at least/.test(pngFailed?.refused) && pngFailed.kept === 'First' && is(pngFailed.pixel, [255, 0, 0]) && /own/.test(pngOnGl)
  if (!pfOk) failed++
  console.log(`${pfOk ? 'ok  ' : 'FAIL'} PNGTuber, a failed load: ${pngFailed?.refused} (kept ${pngFailed?.kept}, pixel ${pngFailed?.pixel}); on a WebGL canvas: ${pngOnGl}`)
  const vaOk = vrmAgain?.aspect1 === 2 && vrmAgain.aspect2 === 2 && /not a VRM/.test(vrmAgain.refused) && vrmAgain.kept === 'Tiny' && vrmAgain.share > 0.02 && /2D/.test(vrmOn2d)
  if (!vaOk) failed++
  console.log(`${vaOk ? 'ok  ' : 'FAIL'} VRM, loaded again on a wide canvas: aspect ${vrmAgain?.aspect1}, ${vrmAgain?.aspect2}; a failed load kept ${vrmAgain?.kept}, covers ${(vrmAgain?.share * 100).toFixed(1)} %; on a 2D canvas: ${vrmOn2d}`)
  if (errors.length) { failed++; console.log(`FAIL page errors:\n  ${errors.join('\n  ')}`) }
  // no WebGL at all: the example pages say so, the check says no, new Player() says why (the pages fail on purpose: no
  // error of theirs counts here)
  const plain = await chromium.launch({ args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-webgl', '--disable-webgl2', '--disable-3d-apis'] })
  try {
    const p = await plain.newPage()
    for (const name of ['index', 'demo', 'gallery']) {
      await p.goto(`http://127.0.0.1:${server.address().port}/example/${name}.html`)
      await p.waitForFunction(() => /WebGL2/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {})
      const said = /WebGL2/.test(await p.evaluate(() => document.body.innerText))
      if (!said) failed++
      console.log(`${said ? 'ok  ' : 'FAIL'} no WebGL: example/${name}.html ${said ? 'says so' : 'says nothing'}`)
    }
    const r = await p.evaluate(async () => {
      const { Player } = await import('/dist/index.js')
      let thrown = ''
      try { new Player(document.createElement('canvas')) } catch (e) { thrown = e.message }
      return { supported: Player.isSupported(), thrown }
    })
    const ok = r.supported === false && /turned off/.test(r.thrown)
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} no WebGL: isSupported ${r.supported}, new Player() says "${r.thrown}"`)
  } finally { await plain.close() }
} finally {
  await browser.close()
  server.close()
}
console.log(failed ? `smoke: ${failed} failed` : `smoke: all ${ids.length} characters ok`)
process.exit(failed ? 1 : 0)
