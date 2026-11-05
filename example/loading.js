// The example pages' wait for a character.
let latest = 0

/** Until `done()`: `cover`, an <img> under the canvas sized like it with object-fit: contain, shows the character's
 *  cover.webp (its first frame, so nothing jumps), then the character fades in over it. Only a model with a folder has a
 *  cover (a package's folder lies beside it); else, and when the load takes long, "Loading…". A newer call takes over. */
export function loading(canvas, cover, source) {
  const me = ++latest
  const url = typeof source === 'string' && /(\/|\.livliv)$/.test(source) ? `${source.replace(/\.livliv$/, '/')}cover.webp` : ''
  if (cover.getAttribute('src') !== url) {
    cover.hidden = true  // not the last character's picture while this one comes
    if (url) cover.src = url; else cover.removeAttribute('src')
  }
  let waiting = true
  if (url) {
    cover.decode().then(() => {
      if (me !== latest || !waiting) return
      cover.hidden = false
      canvas.style.transition = ''
      canvas.style.opacity = 0
    }, () => { if (me === latest) cover.hidden = true })  // no cover: the note below is enough
  }
  const note = document.createElement('p')
  note.textContent = 'Loading…'
  note.style.cssText = 'position:absolute;z-index:1;left:50%;bottom:12%;transform:translateX(-50%);margin:0;padding:4px 10px;border-radius:8px;background:#000a;color:#fff;font:13px system-ui,sans-serif;pointer-events:none'
  const later = setTimeout(() => canvas.parentElement.append(note), url ? 800 : 150)
  return () => {
    waiting = false
    clearTimeout(later)
    note.remove()
    if (me !== latest) return
    if (canvas.style.opacity !== '0') { cover.hidden = true; return }
    canvas.style.transition = 'opacity .25s'
    canvas.style.opacity = 1
    setTimeout(() => { if (me === latest) cover.hidden = true }, 300)
  }
}

/** Is this URL on the page's own site? ?model= opens nothing else: a link must not put someone else's file on this
 *  page, under its address. The buttons are there for other files: a visitor picks those on purpose. */
export function sameSite(url) {
  try { return new URL(url, location.href).origin === location.origin } catch { return false }
}

/** Where WebGL2 is missing: says so on the page and stops the page's script here (new Player() would throw). */
export function needWebGL(Player) {
  if (Player.isSupported()) return
  const note = document.createElement('p')
  note.style.cssText = 'position:fixed;z-index:2;left:16px;right:16px;top:32px;margin:0;padding:8px 12px;border-radius:8px;background:#000c;color:#fff;text-align:center;font:15px/1.5 system-ui,sans-serif'
  note.textContent = 'This browser cannot show the character: it needs WebGL2, which is missing or turned off here.'
  document.body.append(note)
  throw new Error('no WebGL2')
}

/** Loads a model, with a featured character's folder as the second chance when its package (one big file) does not come. */
export async function loadWithFallback(player, source) {
  try {
    return await player.load(source)
  } catch (e) {
    if (typeof source !== 'string' || !source.endsWith('.livliv')) throw e
    return player.load(source.replace(/\.livliv$/, '/')).catch(() => { throw e })
  }
}
