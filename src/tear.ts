/**
 * Tear animation: Verlet physics + layered audio + texture-mapped cover image.
 *
 * Layout:
 *   Top 20% of canvas  → physically simulated mesh, texture-mapped from the
 *                        top 20% slice of the cover PNG.
 *   Bottom 80% of canvas → static cover PNG (no physics).
 *
 * Reveal sequence:
 *   1. User drags to break pin anchors → horizontal tear propagates.
 *   2. After the tear reaches its last constraint, physics keeps running
 *      for PHYSICS_CONTINUATION_MS so the freed flap visibly flops.
 *   3. The whole canvas content then slides down off-screen (ease-in).
 *   4. onRevealed fires — viewer has mounted the letter HTML behind the
 *      canvas, so the reveal is seamless.
 */

export interface TearOptions {
  coverUrl: string | null
  jagStyle: 'straight' | 'light' | 'heavy'
  onRevealed: () => void
}

// ── Audio ────────────────────────────────────────────────────────────────────

const AUDIO_FILES = [
  `${import.meta.env.BASE_URL}audio/slow.aac`,
  `${import.meta.env.BASE_URL}audio/medium.aac`,
  `${import.meta.env.BASE_URL}audio/medium_fast.aac`,
  `${import.meta.env.BASE_URL}audio/fast.aac`,
]

const BLEND_POSITIONS = [0, 1 / 3, 2 / 3, 1]
const BLEND_RATE_MIN = 3
const BLEND_RATE_MAX = 40
const RIPPING_THRESHOLD = 1.2
// Once ripping, stay ripping for at least this long after the last above-
// threshold frame. Smooths out sparse slow-rip breaks so the looping audio
// slots keep streaming instead of restarting from position 0.
const RIP_SUSTAIN_MS = 650
const LOOP_OVERLAP = 0.09
const RAMP_MASTER_IN = 0.12
const RAMP_MASTER_OUT = 0.08
const RAMP_BLEND = 0.08
const BREAK_SMOOTH = 0.35

interface AudioSlot {
  active: boolean
  src: AudioBufferSourceNode | null
  timeoutId: ReturnType<typeof setTimeout> | null
}

class AudioManager {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private trackGains: GainNode[] = []
  private slots: (AudioSlot | null)[] = [null, null, null, null]
  private buffers: (AudioBuffer | null)[] = []
  private isRipping = false
  private lastAboveThresholdMs = 0

  // Raw AAC bytes, prefetched on construction (before any user gesture) so
  // that on mobile the slow network + small CPU doesn't cause the first rip
  // to finish before buffers are ready. decodeAudioData still runs once the
  // AudioContext exists, but that part is fast on pre-downloaded bytes.
  private prefetched: Promise<(ArrayBuffer | null)[]>

  constructor() {
    this.prefetched = Promise.all(
      AUDIO_FILES.map(async (url) => {
        try {
          const res = await fetch(url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return await res.arrayBuffer()
        } catch (e) {
          console.warn(`Audio: prefetch failed for "${url}":`, e)
          return null
        }
      }),
    )
  }

  ensureContext(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new AC()
    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.setValueAtTime(0, this.ctx.currentTime)
    this.masterGain.connect(this.ctx.destination)
    for (let i = 0; i < 4; i++) {
      const g = this.ctx.createGain()
      g.gain.setValueAtTime(0, this.ctx.currentTime)
      g.connect(this.masterGain)
      this.trackGains.push(g)
    }

    // iOS Safari fully unlocks audio only after actually *playing* something
    // inside the user gesture. A 1-sample silent buffer is enough.
    try {
      const silent = this.ctx.createBuffer(1, 1, 22050)
      const src = this.ctx.createBufferSource()
      src.buffer = silent
      src.connect(this.ctx.destination)
      src.start(0)
    } catch {
      /* ignore — unlock best-effort */
    }

    void this.loadBuffers()
  }

  private async loadBuffers(): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    const raw = await this.prefetched
    const results = await Promise.all(
      raw.map(async (ab) => {
        if (!ab) return null
        try {
          // decodeAudioData detaches the source ArrayBuffer in some engines;
          // copy so we could in principle retry (and to be safe in Safari).
          return await ctx.decodeAudioData(ab.slice(0))
        } catch (e) {
          console.warn('Audio: decode failed', e)
          return null
        }
      }),
    )
    this.buffers = results

    // Race-condition safety: if the user is already ripping by the time
    // buffers finally finish decoding, kick off the slots now so they hear
    // sound for the rest of the tear instead of silence.
    if (this.isRipping && this.ctx) {
      for (let i = 0; i < 4; i++) {
        if (!this.slots[i]) this.slots[i] = this.startSlot(i)
      }
      const now = this.ctx.currentTime
      this.masterGain!.gain.cancelScheduledValues(now)
      this.masterGain!.gain.setValueAtTime(this.masterGain!.gain.value, now)
      this.masterGain!.gain.linearRampToValueAtTime(1, now + RAMP_MASTER_IN)
    }
  }

  private startSlot(i: number): AudioSlot | null {
    const buf = this.buffers[i]
    if (!buf || !this.ctx) return null
    const dest = this.trackGains[i]
    const slot: AudioSlot = { active: true, src: null, timeoutId: null }
    const playNext = (): void => {
      if (!slot.active || !this.ctx) return
      const src = this.ctx.createBufferSource()
      src.buffer = buf
      src.connect(dest)
      src.start()
      slot.src = src
      const nextIn = Math.max(10, (buf.duration - LOOP_OVERLAP) * 1000)
      slot.timeoutId = setTimeout(playNext, nextIn)
    }
    playNext()
    return slot
  }

  private stopSlot(slot: AudioSlot | null): void {
    if (!slot) return
    slot.active = false
    if (slot.timeoutId !== null) clearTimeout(slot.timeoutId)
    try {
      slot.src?.stop()
    } catch {
      /* already stopped */
    }
  }

  private blendGains(blend: number): number[] {
    const DECAY = 0.45
    const raw = BLEND_POSITIONS.map((pos, i) => {
      if (i === 0) return 1
      const start = BLEND_POSITIONS[i - 1]
      return Math.min(1, Math.max(0, (blend - start) / (pos - start)))
    })
    let maxActive = 0
    for (let i = 0; i < 4; i++) if (raw[i] > 0) maxActive = i
    return raw.map((r, i) => r * Math.pow(DECAY, maxActive - i))
  }

  private rateToBlend(rate: number): number {
    if (rate <= BLEND_RATE_MIN) return 0
    return Math.min(
      1,
      Math.log(rate / BLEND_RATE_MIN) / Math.log(BLEND_RATE_MAX / BLEND_RATE_MIN),
    )
  }

  update(smoothRate: number): void {
    // Track ripping state even before buffers are ready — otherwise the
    // retroactive slot-start in loadBuffers() never fires on slow mobiles.
    const nowMs = performance.now()
    const aboveThreshold = smoothRate > RIPPING_THRESHOLD
    if (aboveThreshold) this.lastAboveThresholdMs = nowMs
    const sustained = nowMs - this.lastAboveThresholdMs < RIP_SUSTAIN_MS
    const shouldRip = aboveThreshold || (this.isRipping && sustained)

    // State-only path: no context or buffers yet. Just track the flag so
    // that when buffers finally arrive, the retroactive starter sees it.
    if (!this.ctx || !this.buffers[0] || !this.masterGain) {
      this.isRipping = shouldRip
      return
    }
    const now = this.ctx.currentTime

    if (shouldRip && !this.isRipping) {
      this.isRipping = true
      for (let i = 0; i < 4; i++) this.slots[i] = this.startSlot(i)
      this.masterGain.gain.cancelScheduledValues(now)
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now)
      this.masterGain.gain.linearRampToValueAtTime(1, now + RAMP_MASTER_IN)
    } else if (!shouldRip && this.isRipping) {
      this.isRipping = false
      this.masterGain.gain.cancelScheduledValues(now)
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now)
      this.masterGain.gain.linearRampToValueAtTime(0, now + RAMP_MASTER_OUT)
      const slotsCopy = [...this.slots]
      setTimeout(() => slotsCopy.forEach((s) => this.stopSlot(s)), 200)
      this.slots = [null, null, null, null]
    }

    if (this.isRipping) {
      // During the sustained tail (rate dropped but still "ripping"), use
      // the most recent real rate for blend so gains fade to slow naturally.
      const blend = this.rateToBlend(smoothRate)
      const gains = this.blendGains(blend)
      for (let i = 0; i < 4; i++) {
        const g = this.trackGains[i]
        g.gain.cancelScheduledValues(now)
        g.gain.setValueAtTime(g.gain.value, now)
        g.gain.linearRampToValueAtTime(gains[i], now + RAMP_BLEND)
      }
    }
  }

  stop(): void {
    if (!this.ctx || !this.masterGain) return
    const now = this.ctx.currentTime
    this.masterGain.gain.cancelScheduledValues(now)
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now)
    this.masterGain.gain.linearRampToValueAtTime(0, now + 0.15)
    const slotsCopy = [...this.slots]
    setTimeout(() => slotsCopy.forEach((s) => this.stopSlot(s)), 200)
    this.slots = [null, null, null, null]
    this.isRipping = false
  }
}

// ── Physics primitives ───────────────────────────────────────────────────────

class Point {
  x: number
  y: number
  old_x: number
  old_y: number
  r: number
  c: number
  i = 0
  pinned = false
  fixed = false
  isTopHalf = false
  anchorX = 0
  anchorY = 0

  constructor(x: number, y: number, r: number, c: number) {
    this.x = x
    this.y = y
    this.old_x = x
    this.old_y = y
    this.r = r
    this.c = c
  }
}

class Constraint {
  p1: Point
  p2: Point
  restLength: number
  broken = false
  tearable = false
  pathIndex = -1

  constructor(p1: Point, p2: Point) {
    this.p1 = p1
    this.p2 = p2
    this.restLength = Math.hypot(p2.x - p1.x, p2.y - p1.y)
  }
}

interface PinAnchor {
  p: Point
  ax: number
  ay: number
  broken: boolean
}

// ── Grid + physics tuning ────────────────────────────────────────────────────

const COLS = 64
const ROWS = 14
const STRIP_HEIGHT_FRAC = 0.2

const GRAVITY = 0.25
const FRICTION = 0.95
const ITERATIONS = 12
const PAD = 2
const STRETCH_LIMIT = 1.05
const STRESS_DECAY = 0.88
const PIN_STRAIN_GAIN = 0.3
const PIN_BREAK_STRESS = 20
const PIN_SPRING_K = 0.3
const BOTTOM_SPRING_K = 0.08
const BOTTOM_EXTRA_DAMP = 0.6
const BACK_MIN_COMPONENT = 3
const MAX_LAYER = 2
const LAYER_MIN_COMPONENT = 3

interface JagPreset {
  tearMinRowFrac: number
  tearMaxRowFrac: number
  stepDown: number
  stepUp: number
  bigJumpChance: number
}
const JAG_PRESETS: Record<'straight' | 'light' | 'heavy', JagPreset> = {
  straight: { tearMinRowFrac: 0.5, tearMaxRowFrac: 0.5, stepDown: 0, stepUp: 0, bigJumpChance: 0 },
  light: { tearMinRowFrac: 0.4, tearMaxRowFrac: 0.65, stepDown: 0.18, stepUp: 0.18, bigJumpChance: 0.08 },
  heavy: { tearMinRowFrac: 0.3, tearMaxRowFrac: 0.75, stepDown: 0.28, stepUp: 0.28, bigJumpChance: 0.18 },
}

// ── Visuals ──────────────────────────────────────────────────────────────────

const BACK_FILL = '#2a1d15'
const LAYER_SHADOWS = [
  { color: 'rgba(0,0,0,0.35)', blur: 10, offsetY: 4 },
  { color: 'rgba(0,0,0,0.55)', blur: 16, offsetY: 9 },
  { color: 'rgba(0,0,0,0.70)', blur: 22, offsetY: 14 },
]

const PHYSICS_CONTINUATION_MS = 400
const SLIDE_DURATION_MS = 1100

// ── TearCanvas ───────────────────────────────────────────────────────────────

export class TearCanvas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private opts: TearOptions

  private W = 0
  private H = 0
  private stripH = 0

  // Off-screen layer compositing canvas (sized to canvas W×H).
  private offCanvas: HTMLCanvasElement
  private offCtx: CanvasRenderingContext2D

  // Texture canvas — cover image pre-rendered at W×H so source coords match canvas coords.
  private textureCanvas: HTMLCanvasElement
  private textureCtx: CanvasRenderingContext2D
  private coverImg: HTMLImageElement | null = null
  private coverReady = false

  // Physics state (recreated on resize).
  private points: Point[] = []
  private hC: Constraint[][] = [] // [ROWS][COLS-1]
  private vC: Constraint[][] = [] // [ROWS-1][COLS]
  private tearPath: Constraint[] = []
  private tearPathLen = 0
  private pinAnchors: PinAnchor[] = []
  private pinByPoint: (PinAnchor | null)[] = []
  private topConstraints: Constraint[] = []
  private bottomConstraints: Constraint[] = []
  private crossConstraints: Constraint[] = []
  private stress: Float32Array = new Float32Array(0)

  // Quad-grid scratch buffers.
  private flipped: Uint8Array = new Uint8Array(0)
  private compId: Int32Array = new Int32Array(0)
  private isBack: Uint8Array = new Uint8Array(0)
  private layerIdx: Int32Array = new Int32Array(0)
  private layerCompId: Int32Array = new Int32Array(0)
  private layerCompSize: number[] = []
  private layerCompNewLayer: Int32Array = new Int32Array(0)
  private layerCompNeighborCounts: Int32Array = new Int32Array(0)
  private compSize: number[] = []

  // Drag.
  private dragPoint: Point | null = null
  private dragTargetX = 0
  private dragTargetY = 0

  // Audio.
  private audio = new AudioManager()
  private frameBreaks = 0
  private smoothBreakRate = 0

  // Reveal sequence.
  private tearStarted = false
  private tearFinished = false          // all path edges broken
  private tearFinishedAt = 0
  private sliding = false
  private slideStart = 0
  private revealed = false

  // Frame loop.
  private rafId = 0
  private destroyed = false

  constructor(canvas: HTMLCanvasElement, opts: TearOptions) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.opts = opts

    this.offCanvas = document.createElement('canvas')
    this.offCtx = this.offCanvas.getContext('2d')!
    this.textureCanvas = document.createElement('canvas')
    this.textureCtx = this.textureCanvas.getContext('2d')!

    this.W = canvas.width
    this.H = canvas.height
    this.buildGrid()

    if (opts.coverUrl) {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = opts.coverUrl
      img.onload = () => {
        this.coverImg = img
        this.coverReady = true
        this.rebuildTexture()
      }
    }

    this.bindEvents()
    this.loop()
  }

  resize(w: number, h: number): void {
    if (w === this.W && h === this.H) return
    this.W = w
    this.H = h
    this.canvas.width = w
    this.canvas.height = h
    this.buildGrid()
    this.rebuildTexture()
  }

  // ── grid construction ──────────────────────────────────────────────────────

  private buildGrid(): void {
    const W = this.W
    const H = this.H
    this.stripH = H * STRIP_HEIGHT_FRAC

    this.offCanvas.width = W
    this.offCanvas.height = H
    this.textureCanvas.width = W
    this.textureCanvas.height = H

    const spacingX = W / (COLS - 1)
    const spacingY = this.stripH / (ROWS - 1)

    const points: Point[] = []
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = new Point(c * spacingX, r * spacingY, r, c)
        p.i = r * COLS + c
        if (r === ROWS - 1) {
          p.pinned = true
          p.fixed = true
        }
        points.push(p)
      }
    }
    this.points = points

    const idx = (r: number, c: number) => r * COLS + c

    const hC: Constraint[][] = Array.from({ length: ROWS }, () => new Array(COLS - 1))
    const vC: Constraint[][] = Array.from({ length: ROWS - 1 }, () => new Array(COLS))
    const constraints: Constraint[] = []
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS - 1; c++) {
        const ct = new Constraint(points[idx(r, c)], points[idx(r, c + 1)])
        hC[r][c] = ct
        constraints.push(ct)
      }
    }
    for (let r = 0; r < ROWS - 1; r++) {
      for (let c = 0; c < COLS; c++) {
        const ct = new Constraint(points[idx(r, c)], points[idx(r + 1, c)])
        vC[r][c] = ct
        constraints.push(ct)
      }
    }
    this.hC = hC
    this.vC = vC

    // Build tear path (random walk across rows within the jag band).
    const jag = JAG_PRESETS[this.opts.jagStyle]
    const TEAR_MIN_ROW = Math.floor(ROWS * jag.tearMinRowFrac)
    const TEAR_MAX_ROW = Math.floor(ROWS * jag.tearMaxRowFrac)
    const pathRowAt = new Int32Array(COLS)
    let r = TEAR_MIN_ROW + Math.floor(Math.random() * (TEAR_MAX_ROW - TEAR_MIN_ROW + 1))
    pathRowAt[0] = r
    for (let c = 1; c < COLS; c++) {
      const roll = Math.random()
      let step = 0
      if (roll < jag.stepDown) step = -1
      else if (roll < jag.stepDown + jag.stepUp) step = 1
      if (Math.random() < jag.bigJumpChance) step *= 2
      r += step
      if (r < TEAR_MIN_ROW) r = TEAR_MIN_ROW
      if (r > TEAR_MAX_ROW) r = TEAR_MAX_ROW
      pathRowAt[c] = r
    }

    const tearPath: Constraint[] = []
    for (let c = 0; c < COLS; c++) {
      const vEdge = vC[pathRowAt[c]][c]
      vEdge.tearable = true
      vEdge.pathIndex = tearPath.length
      tearPath.push(vEdge)
      if (c < COLS - 1) {
        const y0 = pathRowAt[c]
        const y1 = pathRowAt[c + 1]
        if (y1 > y0) {
          for (let rr = y0 + 1; rr <= y1; rr++) {
            const hEdge = hC[rr][c]
            hEdge.tearable = true
            hEdge.pathIndex = tearPath.length
            tearPath.push(hEdge)
          }
        } else if (y1 < y0) {
          for (let rr = y0; rr >= y1 + 1; rr--) {
            const hEdge = hC[rr][c]
            hEdge.tearable = true
            hEdge.pathIndex = tearPath.length
            tearPath.push(hEdge)
          }
        }
      }
    }
    this.tearPath = tearPath
    this.tearPathLen = tearPath.length

    for (const p of points) p.isTopHalf = p.r <= pathRowAt[p.c]

    const pinAnchors: PinAnchor[] = []
    const pinByPoint: (PinAnchor | null)[] = new Array(points.length).fill(null)
    for (const p of points) {
      if (!p.isTopHalf) continue
      const pin: PinAnchor = { p, ax: p.x, ay: p.y, broken: false }
      pinAnchors.push(pin)
      pinByPoint[p.i] = pin
    }
    this.pinAnchors = pinAnchors
    this.pinByPoint = pinByPoint

    for (const p of points) {
      if (p.isTopHalf) continue
      p.anchorX = p.x
      p.anchorY = p.y
    }

    this.stress = new Float32Array(points.length)

    const topC: Constraint[] = []
    const botC: Constraint[] = []
    const crsC: Constraint[] = []
    for (const ct of constraints) {
      const a = ct.p1.isTopHalf
      const b = ct.p2.isTopHalf
      if (a && b) topC.push(ct)
      else if (!a && !b) botC.push(ct)
      else crsC.push(ct)
    }
    this.topConstraints = topC
    this.bottomConstraints = botC
    this.crossConstraints = crsC

    const QROWS = ROWS - 1
    const QCOLS = COLS - 1
    this.flipped = new Uint8Array(QROWS * QCOLS)
    this.compId = new Int32Array(QROWS * QCOLS)
    this.isBack = new Uint8Array(QROWS * QCOLS)
    this.layerIdx = new Int32Array(QROWS * QCOLS)
    this.layerCompId = new Int32Array(QROWS * QCOLS)
    this.layerCompNewLayer = new Int32Array(QROWS * QCOLS)
    this.layerCompNeighborCounts = new Int32Array(QROWS * QCOLS * (MAX_LAYER + 1))
    this.compSize = []
    this.layerCompSize = []

    // Reset reveal state.
    this.tearStarted = false
    this.tearFinished = false
    this.tearFinishedAt = 0
    this.sliding = false
    this.slideStart = 0
    this.revealed = false
    this.dragPoint = null
  }

  private rebuildTexture(): void {
    if (!this.coverReady || !this.coverImg) return
    this.textureCtx.clearRect(0, 0, this.W, this.H)
    this.textureCtx.drawImage(this.coverImg, 0, 0, this.W, this.H)
  }

  // ── events ─────────────────────────────────────────────────────────────────

  private bindEvents(): void {
    const el = this.canvas
    const onStart = (clientX: number, clientY: number) => {
      if (this.revealed || this.sliding) return
      this.audio.ensureContext()
      const { x, y } = this.canvasCoords(clientX, clientY)
      this.dragPoint = this.findNearest(x, y)
      if (!this.dragPoint) return
      const pin = this.pinByPoint[this.dragPoint.i]
      if (pin) pin.broken = true
      this.dragPoint.pinned = true
      this.dragTargetX = x
      this.dragTargetY = y
      this.tearStarted = true
    }
    const onMove = (clientX: number, clientY: number) => {
      if (!this.dragPoint) return
      const { x, y } = this.canvasCoords(clientX, clientY)
      this.dragTargetX = x
      this.dragTargetY = y
    }
    const onEnd = () => {
      if (this.dragPoint && !this.dragPoint.fixed) {
        this.dragPoint.pinned = false
        this.dragPoint.old_x = this.dragPoint.x
        this.dragPoint.old_y = this.dragPoint.y
      }
      this.dragPoint = null
    }

    el.addEventListener('mousedown', (e) => onStart(e.clientX, e.clientY))
    window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY))
    window.addEventListener('mouseup', onEnd)

    el.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault()
        const t = e.touches[0]
        onStart(t.clientX, t.clientY)
      },
      { passive: false },
    )
    el.addEventListener(
      'touchmove',
      (e) => {
        if (!this.dragPoint) return
        e.preventDefault()
        const t = e.touches[0]
        onMove(t.clientX, t.clientY)
      },
      { passive: false },
    )
    el.addEventListener(
      'touchend',
      (e) => {
        e.preventDefault()
        onEnd()
      },
      { passive: false },
    )
  }

  private canvasCoords(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: ((clientX - rect.left) * this.W) / rect.width,
      y: ((clientY - rect.top) * this.H) / rect.height,
    }
  }

  private findNearest(mx: number, my: number): Point | null {
    let best: Point | null = null
    let bestDist = Infinity
    for (const p of this.points) {
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2
      if (d < bestDist) {
        bestDist = d
        best = p
      }
    }
    return best
  }

  // ── physics ────────────────────────────────────────────────────────────────

  private integrate(): void {
    for (const p of this.points) {
      if (p.pinned) continue
      const vx = (p.x - p.old_x) * FRICTION
      const vy = (p.y - p.old_y) * FRICTION
      p.old_x = p.x
      p.old_y = p.y
      if (p.isTopHalf) {
        p.x += vx
        p.y += vy + GRAVITY
      } else {
        p.x += vx * BOTTOM_EXTRA_DAMP
        p.y += vy * BOTTOM_EXTRA_DAMP
        p.x += (p.anchorX - p.x) * BOTTOM_SPRING_K
        p.y += (p.anchorY - p.y) * BOTTOM_SPRING_K
      }
    }
  }

  private updateStress(): void {
    const stress = this.stress
    for (const pin of this.pinAnchors) {
      if (pin.broken) continue
      const dx = pin.p.x - pin.ax
      const dy = pin.p.y - pin.ay
      stress[pin.p.i] += PIN_STRAIN_GAIN * Math.hypot(dx, dy)
    }
    for (let i = 0; i < stress.length; i++) stress[i] *= STRESS_DECAY
  }

  private trackCursor(): void {
    if (!this.dragPoint) return
    this.dragPoint.x = this.dragTargetX
    this.dragPoint.y = this.dragTargetY
    this.dragPoint.old_x = this.dragTargetX
    this.dragPoint.old_y = this.dragTargetY
  }

  private relaxConstraint(ct: Constraint): void {
    if (ct.broken) return
    const dx = ct.p2.x - ct.p1.x
    const dy = ct.p2.y - ct.p1.y
    const dist = Math.hypot(dx, dy) || 0.0001

    if (ct.tearable && dist > ct.restLength * STRETCH_LIMIT) {
      const pi = ct.pathIndex
      const isEndpoint = pi === 0 || pi === this.tearPathLen - 1
      const prevBroken = pi > 0 && this.tearPath[pi - 1].broken
      const nextBroken = pi < this.tearPathLen - 1 && this.tearPath[pi + 1].broken
      if (isEndpoint || prevBroken || nextBroken) {
        ct.broken = true
        this.frameBreaks++
        return
      }
    }

    const diff = (dist - ct.restLength) / dist
    const p1Pinned = ct.p1.pinned
    const p2Pinned = ct.p2.pinned
    if (p1Pinned && p2Pinned) return
    if (p1Pinned) {
      ct.p2.x -= dx * diff
      ct.p2.y -= dy * diff
    } else if (p2Pinned) {
      ct.p1.x += dx * diff
      ct.p1.y += dy * diff
    } else {
      const ox = dx * 0.5 * diff
      const oy = dy * 0.5 * diff
      ct.p1.x += ox
      ct.p1.y += oy
      ct.p2.x -= ox
      ct.p2.y -= oy
    }
  }

  private relaxGroup(group: Constraint[]): void {
    for (const ct of group) this.relaxConstraint(ct)
  }

  private satisfyPins(): void {
    for (const pin of this.pinAnchors) {
      if (pin.broken) continue
      if (pin.p === this.dragPoint) continue
      if (this.stress[pin.p.i] > PIN_BREAK_STRESS) {
        pin.broken = true
        this.frameBreaks++
        continue
      }
      pin.p.x += (pin.ax - pin.p.x) * PIN_SPRING_K
      pin.p.y += (pin.ay - pin.p.y) * PIN_SPRING_K
    }
  }

  private satisfyConstraints(): void {
    for (let i = 0; i < ITERATIONS; i++) {
      this.trackCursor()
      this.relaxGroup(this.topConstraints)
      this.relaxGroup(this.bottomConstraints)
      this.relaxGroup(this.crossConstraints)
      for (const p of this.points) {
        if (p.pinned) continue
        if (p.x < PAD) p.x = PAD
        else if (p.x > this.W - PAD) p.x = this.W - PAD
        if (p.y < PAD) p.y = PAD
        else if (p.y > this.H - PAD) p.y = this.H - PAD
      }
    }
  }

  // ── quad helpers ──────────────────────────────────────────────────────────

  private quadAlive(r: number, c: number): boolean {
    return (
      !this.hC[r][c].broken &&
      !this.hC[r + 1][c].broken &&
      !this.vC[r][c].broken &&
      !this.vC[r][c + 1].broken
    )
  }

  private computeBackFacing(): void {
    const QROWS = ROWS - 1
    const QCOLS = COLS - 1
    const qIdx = (r: number, c: number) => r * QCOLS + c
    const idx = (r: number, c: number) => r * COLS + c

    this.flipped.fill(0)
    this.compId.fill(-1)
    this.isBack.fill(0)
    this.compSize.length = 0

    for (let r = 0; r < QROWS; r++) {
      for (let c = 0; c < QCOLS; c++) {
        if (!this.quadAlive(r, c)) continue
        const p00 = this.points[idx(r, c)]
        const p01 = this.points[idx(r, c + 1)]
        const p11 = this.points[idx(r + 1, c + 1)]
        const p10 = this.points[idx(r + 1, c)]
        const a =
          0.5 *
          (p00.x * p01.y -
            p01.x * p00.y +
            (p01.x * p11.y - p11.x * p01.y) +
            (p11.x * p10.y - p10.x * p11.y) +
            (p10.x * p00.y - p00.x * p10.y))
        if (a < 0) this.flipped[qIdx(r, c)] = 1
      }
    }

    const floodQueue: number[] = []
    for (let r = 0; r < QROWS; r++) {
      for (let c = 0; c < QCOLS; c++) {
        const startI = qIdx(r, c)
        if (!this.flipped[startI] || this.compId[startI] !== -1) continue
        const id = this.compSize.length
        this.compSize.push(1)
        this.compId[startI] = id
        floodQueue.length = 0
        floodQueue.push(startI)
        while (floodQueue.length) {
          const curr = floodQueue.pop()!
          const rr = (curr / QCOLS) | 0
          const cc = curr - rr * QCOLS
          if (cc + 1 < QCOLS && !this.vC[rr][cc + 1].broken) {
            const j = qIdx(rr, cc + 1)
            if (this.flipped[j] && this.compId[j] === -1) {
              this.compId[j] = id
              this.compSize[id]++
              floodQueue.push(j)
            }
          }
          if (cc > 0 && !this.vC[rr][cc].broken) {
            const j = qIdx(rr, cc - 1)
            if (this.flipped[j] && this.compId[j] === -1) {
              this.compId[j] = id
              this.compSize[id]++
              floodQueue.push(j)
            }
          }
          if (rr + 1 < QROWS && !this.hC[rr + 1][cc].broken) {
            const j = qIdx(rr + 1, cc)
            if (this.flipped[j] && this.compId[j] === -1) {
              this.compId[j] = id
              this.compSize[id]++
              floodQueue.push(j)
            }
          }
          if (rr > 0 && !this.hC[rr][cc].broken) {
            const j = qIdx(rr - 1, cc)
            if (this.flipped[j] && this.compId[j] === -1) {
              this.compId[j] = id
              this.compSize[id]++
              floodQueue.push(j)
            }
          }
        }
      }
    }

    for (let i = 0; i < this.flipped.length; i++) {
      if (this.flipped[i] && this.compSize[this.compId[i]] >= BACK_MIN_COMPONENT) {
        this.isBack[i] = 1
      }
    }
  }

  private computeLayers(): number {
    const QROWS = ROWS - 1
    const QCOLS = COLS - 1
    const qIdx = (r: number, c: number) => r * QCOLS + c

    this.layerIdx.fill(-1)
    let maxSeen = 0
    const layerQueue: number[] = []

    for (let c = 0; c < QCOLS; c++) {
      if (this.quadAlive(0, c)) {
        const i = qIdx(0, c)
        this.layerIdx[i] = 0
        layerQueue.push(i)
      }
    }
    for (let c = 0; c < QCOLS; c++) {
      if (this.quadAlive(QROWS - 1, c)) {
        const i = qIdx(QROWS - 1, c)
        if (this.layerIdx[i] === -1) {
          this.layerIdx[i] = 0
          layerQueue.push(i)
        }
      }
    }

    const drain = () => {
      while (layerQueue.length) {
        const curr = layerQueue.shift()!
        const rr = (curr / QCOLS) | 0
        const cc = curr - rr * QCOLS
        const currLayer = this.layerIdx[curr]
        const currBack = this.isBack[curr]
        const tryVisit = (nr: number, nc: number, edgeOk: boolean) => {
          if (!edgeOk || nr < 0 || nr >= QROWS || nc < 0 || nc >= QCOLS) return
          if (!this.quadAlive(nr, nc)) return
          const j = qIdx(nr, nc)
          if (this.layerIdx[j] !== -1) return
          const faceDiffers = this.isBack[j] !== currBack
          let nextLayer = currLayer + (faceDiffers ? 1 : 0)
          if (nextLayer > MAX_LAYER) nextLayer = MAX_LAYER
          this.layerIdx[j] = nextLayer
          if (nextLayer > maxSeen) maxSeen = nextLayer
          layerQueue.push(j)
        }
        tryVisit(rr, cc + 1, cc + 1 < QCOLS && !this.vC[rr][cc + 1].broken)
        tryVisit(rr, cc - 1, cc > 0 && !this.vC[rr][cc].broken)
        tryVisit(rr + 1, cc, rr + 1 < QROWS && !this.hC[rr + 1][cc].broken)
        tryVisit(rr - 1, cc, rr > 0 && !this.hC[rr][cc].broken)
      }
    }
    drain()

    for (let r = 0; r < QROWS; r++) {
      for (let c = 0; c < QCOLS; c++) {
        if (!this.quadAlive(r, c)) continue
        const i = qIdx(r, c)
        if (this.layerIdx[i] !== -1) continue
        this.layerIdx[i] = 0
        layerQueue.push(i)
        drain()
      }
    }

    return maxSeen
  }

  private filterLayerSpeckle(): void {
    const QROWS = ROWS - 1
    const QCOLS = COLS - 1
    const qIdx = (r: number, c: number) => r * QCOLS + c

    this.layerCompId.fill(-1)
    this.layerCompSize.length = 0

    const floodQueue: number[] = []
    for (let r = 0; r < QROWS; r++) {
      for (let c = 0; c < QCOLS; c++) {
        if (!this.quadAlive(r, c)) continue
        const startI = qIdx(r, c)
        if (this.layerCompId[startI] !== -1) continue
        const id = this.layerCompSize.length
        const L = this.layerIdx[startI]
        this.layerCompId[startI] = id
        this.layerCompSize.push(1)
        floodQueue.length = 0
        floodQueue.push(startI)
        while (floodQueue.length) {
          const curr = floodQueue.pop()!
          const rr = (curr / QCOLS) | 0
          const cc = curr - rr * QCOLS
          if (cc + 1 < QCOLS && !this.vC[rr][cc + 1].broken) {
            const j = qIdx(rr, cc + 1)
            if (this.quadAlive(rr, cc + 1) && this.layerCompId[j] === -1 && this.layerIdx[j] === L) {
              this.layerCompId[j] = id
              this.layerCompSize[id]++
              floodQueue.push(j)
            }
          }
          if (cc > 0 && !this.vC[rr][cc].broken) {
            const j = qIdx(rr, cc - 1)
            if (this.quadAlive(rr, cc - 1) && this.layerCompId[j] === -1 && this.layerIdx[j] === L) {
              this.layerCompId[j] = id
              this.layerCompSize[id]++
              floodQueue.push(j)
            }
          }
          if (rr + 1 < QROWS && !this.hC[rr + 1][cc].broken) {
            const j = qIdx(rr + 1, cc)
            if (this.quadAlive(rr + 1, cc) && this.layerCompId[j] === -1 && this.layerIdx[j] === L) {
              this.layerCompId[j] = id
              this.layerCompSize[id]++
              floodQueue.push(j)
            }
          }
          if (rr > 0 && !this.hC[rr][cc].broken) {
            const j = qIdx(rr - 1, cc)
            if (this.quadAlive(rr - 1, cc) && this.layerCompId[j] === -1 && this.layerIdx[j] === L) {
              this.layerCompId[j] = id
              this.layerCompSize[id]++
              floodQueue.push(j)
            }
          }
        }
      }
    }

    const stride = MAX_LAYER + 1
    const numComps = this.layerCompSize.length
    for (let k = 0; k < numComps * stride; k++) this.layerCompNeighborCounts[k] = 0

    for (let r = 0; r < QROWS; r++) {
      for (let c = 0; c < QCOLS; c++) {
        if (!this.quadAlive(r, c)) continue
        const i = qIdx(r, c)
        const id = this.layerCompId[i]
        if (this.layerCompSize[id] >= LAYER_MIN_COMPONENT) continue
        const base = id * stride
        if (c + 1 < QCOLS && !this.vC[r][c + 1].broken && this.quadAlive(r, c + 1)) {
          const j = qIdx(r, c + 1)
          if (this.layerCompId[j] !== id) this.layerCompNeighborCounts[base + this.layerIdx[j]]++
        }
        if (c > 0 && !this.vC[r][c].broken && this.quadAlive(r, c - 1)) {
          const j = qIdx(r, c - 1)
          if (this.layerCompId[j] !== id) this.layerCompNeighborCounts[base + this.layerIdx[j]]++
        }
        if (r + 1 < QROWS && !this.hC[r + 1][c].broken && this.quadAlive(r + 1, c)) {
          const j = qIdx(r + 1, c)
          if (this.layerCompId[j] !== id) this.layerCompNeighborCounts[base + this.layerIdx[j]]++
        }
        if (r > 0 && !this.hC[r][c].broken && this.quadAlive(r - 1, c)) {
          const j = qIdx(r - 1, c)
          if (this.layerCompId[j] !== id) this.layerCompNeighborCounts[base + this.layerIdx[j]]++
        }
      }
    }

    for (let id = 0; id < numComps; id++) {
      this.layerCompNewLayer[id] = -1
      if (this.layerCompSize[id] >= LAYER_MIN_COMPONENT) continue
      const base = id * stride
      let bestL = -1
      let bestCount = 0
      for (let k = 0; k < stride; k++) {
        const ct = this.layerCompNeighborCounts[base + k]
        if (ct > bestCount) {
          bestCount = ct
          bestL = k
        }
      }
      this.layerCompNewLayer[id] = bestL
    }

    for (let r = 0; r < QROWS; r++) {
      for (let c = 0; c < QCOLS; c++) {
        if (!this.quadAlive(r, c)) continue
        const i = qIdx(r, c)
        const newL = this.layerCompNewLayer[this.layerCompId[i]]
        if (newL !== -1) this.layerIdx[i] = newL
      }
    }
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private drawStaticCoverBelowStrip(targetCtx: CanvasRenderingContext2D): void {
    const y = this.stripH
    const h = this.H - y
    if (h <= 0) return
    if (this.coverReady) {
      targetCtx.drawImage(this.textureCanvas, 0, y, this.W, h, 0, y, this.W, h)
    } else {
      targetCtx.fillStyle = '#f5efe4'
      targetCtx.fillRect(0, y, this.W, h)
    }
  }

  /** Draw an affine-warped triangle from this.textureCanvas into targetCtx. */
  private drawTexturedTriangle(
    targetCtx: CanvasRenderingContext2D,
    sx0: number, sy0: number,
    sx1: number, sy1: number,
    sx2: number, sy2: number,
    dx0: number, dy0: number,
    dx1: number, dy1: number,
    dx2: number, dy2: number,
  ): void {
    const denom = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0)
    if (denom === 0) return
    const a = ((dx1 - dx0) * (sy2 - sy0) - (dx2 - dx0) * (sy1 - sy0)) / denom
    const b = ((dx2 - dx0) * (sx1 - sx0) - (dx1 - dx0) * (sx2 - sx0)) / denom
    const c = ((dy1 - dy0) * (sy2 - sy0) - (dy2 - dy0) * (sy1 - sy0)) / denom
    const d = ((dy2 - dy0) * (sx1 - sx0) - (dy1 - dy0) * (sx2 - sx0)) / denom
    const e = dx0 - a * sx0 - b * sy0
    const f = dy0 - c * sx0 - d * sy0

    targetCtx.save()
    targetCtx.beginPath()
    targetCtx.moveTo(dx0, dy0)
    targetCtx.lineTo(dx1, dy1)
    targetCtx.lineTo(dx2, dy2)
    targetCtx.closePath()
    targetCtx.clip()
    targetCtx.transform(a, c, b, d, e, f)
    targetCtx.drawImage(this.textureCanvas, 0, 0)
    targetCtx.restore()
  }

  private drawQuadLayer(predicate: (r: number, c: number) => boolean): boolean {
    const QROWS = ROWS - 1
    const QCOLS = COLS - 1
    const qIdx = (r: number, c: number) => r * QCOLS + c
    const idx = (r: number, c: number) => r * COLS + c

    const off = this.offCtx
    off.clearRect(0, 0, this.W, this.H)

    let drewAny = false
    const spacingX = this.W / (COLS - 1)
    const spacingY = this.stripH / (ROWS - 1)

    // Back-facing quads: flat dark fill.
    const backPath = new Path2D()
    let hasBack = false
    for (let r = 0; r < QROWS; r++) {
      for (let c = 0; c < QCOLS; c++) {
        if (!this.quadAlive(r, c)) continue
        if (!predicate(r, c)) continue
        if (!this.isBack[qIdx(r, c)]) continue
        const p00 = this.points[idx(r, c)]
        const p01 = this.points[idx(r, c + 1)]
        const p11 = this.points[idx(r + 1, c + 1)]
        const p10 = this.points[idx(r + 1, c)]
        backPath.moveTo(p00.x, p00.y)
        backPath.lineTo(p01.x, p01.y)
        backPath.lineTo(p11.x, p11.y)
        backPath.lineTo(p10.x, p10.y)
        backPath.closePath()
        hasBack = true
      }
    }
    if (hasBack) {
      off.fillStyle = BACK_FILL
      off.fill(backPath)
      drewAny = true
    }

    // Front-facing quads: texture-mapped via two affine triangles each.
    if (this.coverReady) {
      for (let r = 0; r < QROWS; r++) {
        for (let c = 0; c < QCOLS; c++) {
          if (!this.quadAlive(r, c)) continue
          if (!predicate(r, c)) continue
          if (this.isBack[qIdx(r, c)]) continue
          const p00 = this.points[idx(r, c)]
          const p01 = this.points[idx(r, c + 1)]
          const p11 = this.points[idx(r + 1, c + 1)]
          const p10 = this.points[idx(r + 1, c)]
          const sx0 = c * spacingX
          const sy0 = r * spacingY
          const sx1 = (c + 1) * spacingX
          const sy1 = r * spacingY
          const sx2 = (c + 1) * spacingX
          const sy2 = (r + 1) * spacingY
          const sx3 = c * spacingX
          const sy3 = (r + 1) * spacingY
          this.drawTexturedTriangle(
            off,
            sx0, sy0, sx1, sy1, sx2, sy2,
            p00.x, p00.y, p01.x, p01.y, p11.x, p11.y,
          )
          this.drawTexturedTriangle(
            off,
            sx0, sy0, sx2, sy2, sx3, sy3,
            p00.x, p00.y, p11.x, p11.y, p10.x, p10.y,
          )
          drewAny = true
        }
      }
    } else {
      // Fallback: flat front fill.
      const frontPath = new Path2D()
      let hasFront = false
      for (let r = 0; r < QROWS; r++) {
        for (let c = 0; c < QCOLS; c++) {
          if (!this.quadAlive(r, c)) continue
          if (!predicate(r, c)) continue
          if (this.isBack[qIdx(r, c)]) continue
          const p00 = this.points[idx(r, c)]
          const p01 = this.points[idx(r, c + 1)]
          const p11 = this.points[idx(r + 1, c + 1)]
          const p10 = this.points[idx(r + 1, c)]
          frontPath.moveTo(p00.x, p00.y)
          frontPath.lineTo(p01.x, p01.y)
          frontPath.lineTo(p11.x, p11.y)
          frontPath.lineTo(p10.x, p10.y)
          frontPath.closePath()
          hasFront = true
        }
      }
      if (hasFront) {
        off.fillStyle = '#f5efe4'
        off.fill(frontPath)
        drewAny = true
      }
    }

    return drewAny
  }

  private blitLayer(shadow: typeof LAYER_SHADOWS[number]): void {
    const ctx = this.ctx
    ctx.save()
    ctx.shadowColor = shadow.color
    ctx.shadowBlur = shadow.blur
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = shadow.offsetY
    ctx.drawImage(this.offCanvas, 0, 0)
    ctx.restore()
  }

  private render(): void {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.W, this.H)

    // If sliding: translate everything downward with ease-in acceleration.
    let slideY = 0
    if (this.sliding) {
      const elapsed = performance.now() - this.slideStart
      const t = Math.min(1, elapsed / SLIDE_DURATION_MS)
      const eased = t * t * t // ease-in cubic
      slideY = eased * (this.H * 1.15)
      ctx.save()
      ctx.translate(0, slideY)
    }

    this.drawStaticCoverBelowStrip(ctx)

    this.computeBackFacing()
    const maxLayer = this.computeLayers()
    this.filterLayerSpeckle()

    const QCOLS = COLS - 1
    const qIdx = (r: number, c: number) => r * QCOLS + c

    for (let L = 0; L <= maxLayer; L++) {
      const predicate = (r: number, c: number) => this.layerIdx[qIdx(r, c)] >= L
      if (this.drawQuadLayer(predicate)) {
        this.blitLayer(LAYER_SHADOWS[Math.min(L, LAYER_SHADOWS.length - 1)])
      }
    }

    if (this.sliding) {
      ctx.restore()
      if (slideY > this.H * 1.1 && !this.revealed) {
        this.revealed = true
        this.audio.stop()
        this.opts.onRevealed()
      }
    }
  }

  // ── main loop ──────────────────────────────────────────────────────────────

  private allTearPathBroken(): boolean {
    for (let i = 0; i < this.tearPathLen; i++) {
      if (!this.tearPath[i].broken) return false
    }
    return true
  }

  private loop = (): void => {
    if (this.destroyed) return
    this.rafId = requestAnimationFrame(this.loop)

    if (!this.revealed) {
      this.frameBreaks = 0
      this.integrate()
      this.updateStress()
      this.satisfyConstraints()
      this.satisfyPins()

      this.smoothBreakRate =
        this.smoothBreakRate * (1 - BREAK_SMOOTH) + this.frameBreaks * BREAK_SMOOTH
      this.audio.update(this.smoothBreakRate)

      // Detect tear completion.
      if (!this.tearFinished && this.tearStarted && this.allTearPathBroken()) {
        this.tearFinished = true
        this.tearFinishedAt = performance.now()
      }

      // After physics continuation, begin slide.
      if (
        this.tearFinished &&
        !this.sliding &&
        performance.now() - this.tearFinishedAt >= PHYSICS_CONTINUATION_MS
      ) {
        this.sliding = true
        this.slideStart = performance.now()
      }
    }

    this.render()
  }

  destroy(): void {
    this.destroyed = true
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.audio.stop()
  }
}
