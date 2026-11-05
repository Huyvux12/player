// The camera button of the example pages. A click says what the camera is for before the browser asks; a camera that is
// refused or missing gets a short note and a demo motion, which needs no camera, instead of an error.
const INTRO = 'The character follows your face through your camera. Images stay on your device.'
const NOTES = {
  NotAllowedError: 'Camera not allowed. Turn it on from the icon in the address bar, then try again.',
  NotFoundError: 'No camera found.',
  NotReadableError: 'The camera is busy in another app.',
}

const style = document.createElement('style')
style.textContent = `
  .camera-card { position: fixed; z-index: 2; box-sizing: border-box; width: min(320px, calc(100vw - 24px)); padding: 12px;
    border-radius: 12px; background: #2d303c; color: #eef; font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 6px 24px #0006 }
  .camera-card p { margin: 0 0 10px }
  .camera-card div { display: flex; flex-wrap: wrap; gap: 6px }
  .camera-card button { font: inherit; padding: 6px 11px; border: 0; border-radius: 8px; background: #ffffff1c; color: inherit; cursor: pointer }
  .camera-card button:first-child { background: #ff4d5e }`
document.head.append(style)

/** Makes `button` start and stop face tracking on `player`, saying how it goes in `status`. `.running` is the tracking. */
export function cameraButton(button, player, status) {
  let running = null, card = null, before = ''

  const closeCard = () => { card?.remove(); card = null; removeEventListener('keydown', onKey) }
  const onKey = (e) => { if (e.key === 'Escape') closeCard() }

  function openCard(text, again) {
    closeCard()
    card = document.createElement('div')
    card.className = 'camera-card'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', 'Camera')
    const line = document.createElement('p'), row = document.createElement('div')
    line.textContent = text
    for (const [label, trace] of [[again ? 'Try again' : 'Turn on camera', undefined], ['Show a demo', 'synth']]) {
      const b = document.createElement('button')
      b.textContent = label
      b.onclick = () => start(trace)
      row.append(b)
    }
    card.append(line, row)
    document.body.append(card)
    const at = button.getBoundingClientRect()
    card.style.top = `${at.bottom + 8}px`
    card.style.left = `${Math.max(12, Math.min(at.left, innerWidth - card.offsetWidth - 12))}px`
    row.firstChild.focus()
    addEventListener('keydown', onKey)
  }

  async function start(trace) {
    closeCard()
    before ||= status.textContent
    button.disabled = true
    let asking = true  // the face model goes on downloading after a refusal: its progress is no news then
    try {
      const { startFaceTracking } = await import('../dist/tracking.js')
      running = await startFaceTracking(player, {
        trace,
        onProgress: (s) => { if (asking) status.textContent = s.step === 'download' ? `Face model ${Math.round(s.progress * 100)}%` : `${s.step}…` },
      })
      asking = false
      status.textContent = trace ? 'Demo motion, no camera in use' : 'Camera on'
    } catch (e) {
      asking = false
      status.textContent = before
      if (!NOTES[e.name]) console.error('Face tracking could not start:', e)
      openCard(NOTES[e.name] || 'Face tracking could not start. The console has the details.', true)
    }
    button.disabled = false
    button.setAttribute('aria-pressed', String(!!running))
  }

  button.onclick = () => {
    if (card) return closeCard()
    if (!running) return openCard(INTRO)
    running.stop()
    running = null
    status.textContent = before
    before = ''
    button.setAttribute('aria-pressed', 'false')
  }
  return { get running() { return running } }
}
