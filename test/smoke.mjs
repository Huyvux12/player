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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' }
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
/** a face model that takes a while to arrive, for what happens to its download (runDownload in bodies.html) */
const slowModel = { asked: 0, finished: 0 }
/** requests per route of runDropped */
const dropped = {}
const server = createServer((req, res) => {
  if (req.url.startsWith('/__model.task')) {
    slowModel.asked++
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    let left = 25
    const tick = setInterval(() => {
      if (res.destroyed) { clearInterval(tick); return }
      res.write(Buffer.alloc(150_000))
      if (--left === 0) { clearInterval(tick); slowModel.finished++; res.end() }
    }, 40)
    res.on('close', () => clearInterval(tick))
    return
  }
  const drop = req.url.match(/^\/__dropped\/(once|always|missing)\/(.+)\.livliv$/)
  if (drop) {
    const [, how, id] = drop, n = (dropped[how] = (dropped[how] || 0) + 1)
    if (how === 'missing') { res.writeHead(404).end(); return }
    const b = readFileSync(join(chars, `${id}.livliv`))
    if (how === 'always' || n === 1) {  // half of the file, then the connection goes
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': b.length })
      res.write(b.subarray(0, b.length >> 1), () => res.destroy())
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': b.length }).end(b)
    return
  }
  if (req.url === '/__tiny.vrm') { res.writeHead(200, { 'content-type': 'model/gltf-binary' }).end(vrm); return }
  const spoiled = req.url.match(/^\/__tiny\/([^/]+)\.vrm$/)
  if (spoiled) { res.writeHead(200, { 'content-type': 'model/gltf-binary' }).end(tinyVrm(JSON.parse(decodeURIComponent(spoiled[1])))); return }
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
  const { out, fromFiles, newer, legacy, packaged, vrmHere, vrmFolder } = await page.evaluate((a) => window.run(a), { ids, files })
  const vrmHereOk = /BodyPlayer/.test(vrmHere) && /BodyPlayer/.test(vrmFolder)
  if (!vrmHereOk) failed++
  console.log(`${vrmHereOk ? 'ok  ' : 'FAIL'} a VRM handed to a Player: ${vrmHere}`)
  for (const r of out) {
    // the featured characters carry the LivLiv mark in the corner only: the player must draw it there and nowhere else
    const ok = !r.error && r.share > 0.05 && r.glError === 0 && r.watermark === 'LivLiv' && r.mark > 0.001 && r.outside < 0.0003 && r.noise < 0.0005
      && r.license === ({ p01: 'CC-BY-NC-SA-4.0', p02: 'CC-BY-NC-SA-4.0', p03: 'LicenseRef-Third-Party-Character' }[r.id] ?? 'LicenseRef-LivLiv-Samples')
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
  const why = { bomb: /too large/, path: /not an image path|not a path/, canvas: /canvas/, box: /box/, json: /not a model\.json/, layers: /layers/, mesh: /vertices/, chain: /no id/, browLine: /brow line/, rig: /rig\.roll/ }
  for (const [k, re] of Object.entries(why)) {
    const r = hostile[k], ok = !r.loaded && re.test(r.refused) && !!r.kept
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} refuses ${k}: ${r.loaded ? 'it loaded' : r.refused.slice(0, 110)} (kept: ${r.kept})`)
  }
  const kfOk = hostile.keyforms.loaded && hostile.keyforms.share > 0.05
  if (!kfOk) failed++
  console.log(`${kfOk ? 'ok  ' : 'FAIL'} broken keyforms: ${hostile.keyforms.refused ?? `${hostile.keyforms.name} plays on the rig alone`}`)

  // random changes to a model.json in the real player (see runFuzz): the seeds of a run are the same every time
  const fuzzed = await page.evaluate(([a, b]) => window.runFuzz(a, b, 1, 150), [ids.find((i) => i === 'k02') ?? ids[0], ids[0]])
  const fuzzOk = !fuzzed.wrong.length
  if (!fuzzOk) failed++
  console.log(`${fuzzOk ? 'ok  ' : 'FAIL'} 150 changed models: ${fuzzed.counts.refused} refused, ${fuzzed.counts.loaded} loaded, of them ${fuzzed.counts.blank} blank${fuzzOk ? '' : `\n  ${fuzzed.wrong.join('\n  ')}`}`)
  // a package whose connection drops (see runDropped)
  const drops = await page.evaluate((id) => window.runDropped(id), ids[0])
  const dropsOk = /^played/.test(drops.once) && dropped.once === 2 && /could not load/.test(drops.always) && !/Failed to fetch/.test(drops.always) && dropped.always === 2
    && /HTTP 404/.test(drops.missing) && dropped.missing === 1
  if (!dropsOk) failed++
  console.log(`${dropsOk ? 'ok  ' : 'FAIL'} a package's connection drops: once "${drops.once}" (${dropped.once} requests), always "${drops.always.slice(0, 60)}…" (${dropped.always}), a 404 "${drops.missing.slice(0, 50)}…" (${dropped.missing})`)

  // disposing while something runs (see runLifecycle)
  const life = await page.evaluate((id) => window.runLifecycle(id), ids[0])
  const lifeOk = /disposed/.test(life.load) && life.model === null && life.drawn === 0 && life.freed >= life.made && life.glError === 0
    && life.driver === 1 && !!life.again && life.mic === 'ended' && life.supported === true
    && Object.values(life.left).every((n) => n <= 0)
  if (!lifeOk) failed++
  console.log(`${lifeOk ? 'ok  ' : 'FAIL'} dispose while running: load "${life.load}", ${life.made} textures made, ${life.freed} freed, drawn ${life.drawn}, GL error ${life.glError}, driver disposed ${life.driver}, a new player ${life.again}, microphone ${life.mic}, left on the GPU after 3 loads and dispose ${JSON.stringify(life.left)}`)

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
    && ['Smile', 'Happy', 'Sad', 'Surprised', 'Wink'].every((l) => v.expressions.includes(l))
  if (!vrmOk) failed++
  console.log(`${vrmOk ? 'ok  ' : 'FAIL'} VRM: ${v.error ?? `${v.name}, ${v.expressions.join(' / ')}, covers ${(v.share * 100).toFixed(1)} %, face tracked ${v.tracked}`}`)
  for (const spec of [1, 0]) {
    const u = encodeURIComponent(JSON.stringify({ spec }))
    const r = await page.evaluate((url) => window.runVrmPose(url), `/__tiny/${u}.vrm`)
    const ok = String(r.spec) === String(spec) && r.hand < -0.1 && r.yaw > 0.1 && r.pitch > 0.1 && r.roll > 0.1 && r.up > 0.05 && r.down === 0 && r.right > 0.05
      && r.terms.spec === String(spec) && r.terms.author.name === 'LivLiv Player tests' && r.terms.use === 'everyone' && r.terms.commercial === (spec ? 'personal non-profit' : 'allow') && r.terms.license
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} VRM ${spec === 0 ? '0.x' : '1.0'} stands and moves: hand ${r.hand.toFixed(2)} below the shoulder, turn ${r.yaw.toFixed(2)}, nod ${r.pitch.toFixed(2)}, roll ${r.roll.toFixed(2)}, gaze up ${r.up.toFixed(2)} down ${r.down.toFixed(2)} right ${r.right.toFixed(2)}; terms ${r.terms.author.name}, ${r.terms.commercial}`)
  }
  // files a VRM player refuses, saying why; one naming an outside file must not make the page ask for it
  const tiny = (o) => `/__tiny/${encodeURIComponent(JSON.stringify(o))}.vrm`
  let outsideAsked = 0
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/__outside.png') outsideAsked++ })
  const no = await page.evaluate((urls) => window.runVrmRefusals(urls), { noMesh: tiny({ noMesh: true }), draco: tiny({ draco: true }), bigImage: tiny({ bigImage: true }),
    outside: tiny({ outsideImage: `http://127.0.0.1:${server.address().port}/__outside.png` }) })
  const noOk = /no mesh/.test(no.noMesh) && /Draco/.test(no.draco) && /too large/.test(no.bigImage) && /outside itself/.test(no.outside) && outsideAsked === 0 && /not a VRM/.test(no.plainFile) && no.kept === 'Tiny'
  if (!noOk) failed++
  console.log(`${noOk ? 'ok  ' : 'FAIL'} VRM files refused, the character before kept (${no.kept}), outside requests ${outsideAsked}: ${[no.noMesh, no.draco, no.bigImage, no.outside, no.plainFile].map((m) => m.replace(/^LivLiv: \S+ /, '').slice(0, 34)).join(' | ')}`)

  // in any units: a character 100 times too big, or a tenth of the size, still fills the frame
  for (const unit of [100, 0.1]) {
    const u = encodeURIComponent(JSON.stringify({ unit }))
    const share = await page.evaluate((url) => window.runVrmShare(url), `/__tiny/${u}.vrm`)
    const ok = share > 0.1
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} VRM in units of ${unit}: covers ${(share * 100).toFixed(1)} % of the canvas`)
  }
  const pfOk = /needs at least/.test(pngFailed?.refused) && pngFailed.kept === 'First' && is(pngFailed.pixel, [255, 0, 0]) && /own/.test(pngOnGl)
  if (!pfOk) failed++
  console.log(`${pfOk ? 'ok  ' : 'FAIL'} PNGTuber, a failed load: ${pngFailed?.refused} (kept ${pngFailed?.kept}, pixel ${pngFailed?.pixel}); on a WebGL canvas: ${pngOnGl}`)
  const vaOk = vrmAgain?.aspect1 === 2 && vrmAgain.aspect2 === 2 && /not a VRM/.test(vrmAgain.refused) && vrmAgain.kept === 'Tiny' && vrmAgain.share > 0.02 && /2D/.test(vrmOn2d)
  if (!vaOk) failed++
  console.log(`${vaOk ? 'ok  ' : 'FAIL'} VRM, loaded again on a wide canvas: aspect ${vrmAgain?.aspect1}, ${vrmAgain?.aspect2}; a failed load kept ${vrmAgain?.kept}, covers ${(vrmAgain?.share * 100).toFixed(1)} %; on a 2D canvas: ${vrmOn2d}`)
  if (errors.length) { failed++; console.log(`FAIL page errors:\n  ${errors.join('\n  ')}`) }
  // a camera that is refused: the face model's download stops with it, unless someone asked for the model ahead of time
  await page.goto(`http://127.0.0.1:${server.address().port}/test/bodies.html`)
  await page.waitForFunction(() => typeof window.runBodies === 'function')
  const refused = await page.evaluate(() => window.runRefused())
  await new Promise((r) => setTimeout(r, 1500))
  const refusedOk = refused === 'NotAllowedError' && slowModel.finished === 0
  if (!refusedOk) failed++
  console.log(`${refusedOk ? 'ok  ' : 'FAIL'} camera refused (${refused}): the face model asked ${slowModel.asked} time(s), finished ${slowModel.finished}`)
  await page.evaluate(() => window.runRefused(true)).catch(() => {})
  await new Promise((r) => setTimeout(r, 2000))
  const aheadOk = slowModel.finished === 1
  if (!aheadOk) failed++
  console.log(`${aheadOk ? 'ok  ' : 'FAIL'} camera refused after a preload: the download goes on (finished ${slowModel.finished})`)

  // the example pages: the cover in the canvas's box until the character is ready, then the character over it
  for (const name of ['index', 'demo', 'gallery']) {
    const p = await browser.newPage()
    let go
    const held = new Promise((r) => { go = r })
    await p.route('**/characters/*.livliv', async (route) => { await held; await route.continue() })
    await p.goto(`http://127.0.0.1:${server.address().port}/example/${name}.html`)
    const waited = await p.waitForFunction(() => {
      const c = document.getElementById('cover'), s = document.getElementById('stage'), a = c.getBoundingClientRect(), b = s.getBoundingClientRect()
      return c.naturalWidth > 0 && !c.hidden && getComputedStyle(s).opacity === '0' && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
    }, null, { timeout: 8000 }).then(() => true, () => false)
    go()
    const faded = await p.waitForFunction(() => document.getElementById('cover').hidden && getComputedStyle(document.getElementById('stage')).opacity === '1', null, { timeout: 20000 }).then(() => true, () => false)
    if (!waited || !faded) failed++
    console.log(`${waited && faded ? 'ok  ' : 'FAIL'} example/${name}.html: cover first ${waited}, then the character ${faded}`)
    await p.close()
  }
  // ?model=: never a request to another site, however it is written; the page's own files still open
  for (const name of ['demo', 'vrm']) {
    const p = await browser.newPage(), asked = []
    p.on('request', (r) => asked.push(r.url()))
    let tried = 0, left = 0, said = 0
    for (const other of ['https://example.invalid/x/', '//example.invalid/x/', '\\\\example.invalid/x/', 'https:example.invalid/x/', ' https://example.invalid/x/']) {
      await p.goto(`http://127.0.0.1:${server.address().port}/example/${name}.html?model=${encodeURIComponent(other)}`)
      await p.waitForFunction(() => /this site only/.test(document.getElementById('status').textContent), null, { timeout: 8000 }).then(() => { said++ }, () => {})
      tried++
    }
    left = asked.filter((u) => /example\.invalid/.test(new URL(u).host)).length
    const ok = said === tried && !left
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} example/${name}.html: ?model= on another site: ${said}/${tried} said no, ${left} requests left this site`)
    await p.close()
  }
  {
    const p = await browser.newPage()
    await p.goto(`http://127.0.0.1:${server.address().port}/example/demo.html?model=${encodeURIComponent(`../characters/${ids[0]}/`)}`)
    const ok = await p.waitForFunction(() => window.player?.model, null, { timeout: 20000 }).then(() => true, () => false)
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} example/demo.html: ?model= on this site opens`)
    await p.close()
  }
  // no WebGL at all: the example pages say so, the check says no, new Player() says why (the pages fail on purpose: no
  // error of theirs counts here)
  const plain = await chromium.launch({ args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-webgl', '--disable-webgl2', '--disable-3d-apis'] })
  try {
    const p = await plain.newPage()
    for (const name of ['index', 'demo', 'gallery']) {
      await p.goto(`http://127.0.0.1:${server.address().port}/example/${name}.html`)
      await p.waitForFunction(() => /WebGL2/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {})
      // said where it can be read: on the first screen, whatever the canvas takes up
      const said = await p.evaluate(() => {
        const e = [...document.querySelectorAll('p')].find((x) => /WebGL2/.test(x.textContent)), r = e?.getBoundingClientRect()
        return !!r && r.top >= 0 && r.bottom <= innerHeight
      })
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
