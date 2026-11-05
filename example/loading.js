// The example pages' wait for a character.
/** A picture and "Loading…" over the page until `done()`, shown only if the load takes a moment. */
export function loading(parent, picture) {
  const box = document.createElement('div')
  box.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;pointer-events:none'
  if (picture) {
    const img = new Image(96, 96)
    img.alt = ''
    img.style.borderRadius = '12px'
    img.onerror = () => img.remove()
    img.src = picture
    box.append(img)
  }
  box.append('Loading…')
  const later = setTimeout(() => parent.append(box), 150)
  return () => { clearTimeout(later); box.remove() }
}

/** Where WebGL2 is missing: says so on the page and stops the page's script here (new Player() would throw). */
export function needWebGL(Player) {
  if (Player.isSupported()) return
  const note = document.createElement('p')
  note.style.cssText = 'margin:32px 16px;text-align:center;font:15px/1.5 system-ui,sans-serif'
  note.textContent = 'This browser cannot show the character: it needs WebGL2, which is missing or turned off here.'
  document.body.append(note)
  throw new Error('no WebGL2')
}
