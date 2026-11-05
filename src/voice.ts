// @livliv/player/voice: lip sync. The mouth follows a voice (loudness, and the vowel's shape where the model has round /
// wide mouths), and without face tracking the voice also moves the head, brows and eyes a little, the way people move
// while they talk. Two ways in:
//  - startLipSync: live audio (the microphone, a call's MediaStream, or an <audio> / <video> element the page plays)
//  - createSpeech: speech clips (TTS) the player plays itself, back to back; the mouth follows each one exactly, from
//    its loudness worked out when it is decoded and read at the moment the sound leaves the speakers
import { VoiceMeter } from './runtime/voice'
import { SpeechPlayer } from './runtime/speech'
import { TalkMotion } from './runtime/talk'
import type { Driver, Host } from './index'

export interface LipSyncOptions {
  /** how much the voice also moves the head, brows and eyes: 0 (off) .. 2, default 1. Not while a face is tracked */
  motion?: number
  /** hop a little on syllables, like a PNGTuber (default false) */
  bounce?: boolean
}

export interface LipSync {
  /** the mouth openness the voice gives now, 0..1 */
  readonly level: number
  /** mouth sensitivity (default 1) */
  gain: number
  /** stops listening (a stream or element you passed in stays yours, and keeps playing) */
  stop(): void
}

export interface Speech {
  /** queues a clip (a URL, or audio bytes); it plays right after the ones before it */
  say(clip: string | Blob | ArrayBuffer): void
  /** silence now: what plays stops, what is still loading is dropped */
  stop(): void
  /** call inside a user gesture (a click, a key press) before the first say(), or browsers keep the sound blocked */
  unlock(): void
  /** something is playing or still loading */
  readonly busy: boolean
  /** called when the last clip has played */
  onIdle?: () => void
  /** stops, and removes the lip sync from the player */
  dispose(): void
}

function mouth(read: () => number, vowel: () => number, o: LipSyncOptions): Driver {
  const talk = new TalkMotion()
  return {
    order: 10,
    update(f, player) {
      const level = read(), P = f.params
      P.mouthOpen = Math.max(P.mouthOpen, level)
      P.vowel = vowel()
      const amount = o.motion ?? 1
      if (!f.tracked && amount > 0) {
        talk.amount = amount; talk.bounce = !!o.bounce
        f.add(talk.update(level, f.dt, P))
        if (talk.pauseBlink) player.blink()
        f.move.y += talk.hop
      } else if (talk.act || talk.hop) talk.reset()
    },
  }
}

/** Lip sync to live audio: the microphone (no source; asks for permission), a MediaStream, or an <audio> / <video>
 *  element. An element is routed through Web Audio for good once passed here (browsers allow it once per element): it
 *  keeps playing through the speakers after stop() */
export async function startLipSync(player: Host, source?: MediaStream | HTMLMediaElement, options: LipSyncOptions = {}): Promise<LipSync> {
  const m = new VoiceMeter()
  await m.start(source)
  const remove = player.use({ ...mouth(() => m.read(), () => m.vowel, options), dispose: () => m.stop() })
  return {
    get level() { return m.level },
    get gain() { return m.gain },
    set gain(g: number) { m.gain = g },
    stop: remove,
  }
}

/** Speech clips with lip sync (TTS replies): say() queues each one */
export function createSpeech(player: Host, options: LipSyncOptions = {}): Speech {
  const s = new SpeechPlayer()
  const remove = player.use({ ...mouth(() => s.read(), () => s.vowel(), options), dispose: () => s.dispose() })
  const speech: Speech = {
    say(clip) {
      if (typeof clip === 'string') { s.enqueue(new URL(clip, document.baseURI).href); return }
      const u = URL.createObjectURL(clip instanceof Blob ? clip : new Blob([clip]))
      s.enqueue(u)
      setTimeout(() => URL.revokeObjectURL(u), 60_000)  // fetched by then
    },
    stop: () => s.stop(),
    unlock: () => s.unlock(),
    get busy() { return s.busy },
    dispose: remove,
  }
  s.onIdle = () => speech.onIdle?.()
  return speech
}
