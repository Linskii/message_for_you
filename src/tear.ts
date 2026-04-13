/**
 * Tear animation module.
 *
 * Renders a "sealed package" rectangle the user can rip open by dragging
 * from the top-left corner. The tear propagates horizontally based on drag
 * distance & velocity, then the top flap drops away and the letter is revealed.
 */

export interface TearOptions {
  /** Cover image URL (null = plain white) */
  coverUrl: string | null
  /** Tear style */
  jagStyle: 'straight' | 'light' | 'heavy'
  /** Called when the reveal animation completes */
  onRevealed: () => void
}

const CORNER_RADIUS = 40   // px — how close to the corner activates the rip
const FLAP_DROP_DURATION = 600 // ms — how long the top flap falls after full tear

export class TearCanvas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private opts: TearOptions

  // cover image
  private coverImg: HTMLImageElement | null = null

  // interaction state
  private active = false          // currently dragging
  private tearProgress = 0        // 0 → 1 (proportion across width)
  private lastX = 0
  private velocity = 0            // px/frame, used to modulate jaggedness

  // cached tear path (array of y-offsets per x pixel)
  private tearPath: number[] = []

  // drop animation
  private dropping = false
  private dropStart = 0
  private revealed = false

  constructor(canvas: HTMLCanvasElement, opts: TearOptions) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.opts = opts

    if (opts.coverUrl) {
      const img = new Image()
      img.src = opts.coverUrl
      img.onload = () => {
        this.coverImg = img
        this.draw()
      }
    }

    this.bindEvents()
    this.draw()
    this.loop()
  }

  // ── public ──────────────────────────────────────────────────────────────────

  resize(w: number, h: number): void {
    this.canvas.width = w
    this.canvas.height = h
    this.tearPath = []
    this.draw()
  }

  // ── private: event binding ───────────────────────────────────────────────────

  private bindEvents(): void {
    const el = this.canvas

    const onStart = (x: number, y: number) => {
      if (this.revealed || this.dropping) return
      const inCorner = x < CORNER_RADIUS && y < CORNER_RADIUS
      if (!inCorner) return
      this.active = true
      this.lastX = x
    }

    const onMove = (x: number, _y: number) => {
      if (!this.active) return
      const dx = x - this.lastX
      this.velocity = dx
      this.lastX = x

      const newProgress = Math.min(1, Math.max(this.tearProgress, x / this.canvas.width))
      this.tearProgress = newProgress

      // extend the tear path as progress grows
      this.extendTearPath()

      if (this.tearProgress >= 1) {
        this.active = false
        this.startDrop()
      }
    }

    const onEnd = () => {
      this.active = false
    }

    // mouse
    el.addEventListener('mousedown', (e) => {
      const r = el.getBoundingClientRect()
      onStart(e.clientX - r.left, e.clientY - r.top)
    })
    window.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect()
      onMove(e.clientX - r.left, e.clientY - r.top)
    })
    window.addEventListener('mouseup', onEnd)

    // touch
    el.addEventListener('touchstart', (e) => {
      e.preventDefault()
      const t = e.touches[0]
      const r = el.getBoundingClientRect()
      onStart(t.clientX - r.left, t.clientY - r.top)
    }, { passive: false })
    window.addEventListener('touchmove', (e) => {
      if (!this.active) return
      e.preventDefault()
      const t = e.touches[0]
      const r = el.getBoundingClientRect()
      onMove(t.clientX - r.left, t.clientY - r.top)
    }, { passive: false })
    window.addEventListener('touchend', onEnd)
  }

  // ── private: tear path ───────────────────────────────────────────────────────

  /** Build/extend the tear path up to the current tearProgress x-pixel */
  private extendTearPath(): void {
    const w = this.canvas.width
    const targetX = Math.floor(this.tearProgress * w)
    const startX = this.tearPath.length

    if (startX >= targetX) return

    const { jagStyle } = this.opts
    const baseY = this.canvas.height * 0.25 // tear happens 25% from top

    // amplitude of jag scales with velocity for "force" feel
    const velAmp = Math.min(Math.abs(this.velocity) * 0.4, 1)

    const maxJag =
      jagStyle === 'straight' ? 0
      : jagStyle === 'light'   ? 6 + velAmp * 6
      :                           14 + velAmp * 14

    // Perlin-ish: carry a wandering offset
    let offset = this.tearPath.length > 0 ? this.tearPath[this.tearPath.length - 1] - baseY : 0

    for (let x = startX; x < targetX; x++) {
      if (jagStyle === 'straight') {
        this.tearPath[x] = baseY
      } else {
        // Random walk clamped to maxJag
        offset += (Math.random() - 0.5) * maxJag * 0.4
        offset = Math.max(-maxJag, Math.min(maxJag, offset))
        this.tearPath[x] = baseY + offset
      }
    }
  }

  // ── private: drop animation ──────────────────────────────────────────────────

  private startDrop(): void {
    this.dropping = true
    this.dropStart = performance.now()
  }

  // ── private: render ──────────────────────────────────────────────────────────

  private loop(): void {
    requestAnimationFrame(() => {
      this.draw()
      this.loop()
    })
  }

  private draw(): void {
    const { canvas, ctx } = this
    const W = canvas.width
    const H = canvas.height

    ctx.clearRect(0, 0, W, H)

    if (this.revealed) return

    if (this.dropping) {
      const elapsed = performance.now() - this.dropStart
      const t = Math.min(elapsed / FLAP_DROP_DURATION, 1)
      const eased = easeInCubic(t)

      // draw bottom part (stays in place)
      this.drawCover(0, 0, W, H, 0, 0)
      this.clipBelowTear()

      // draw top flap falling down
      ctx.save()
      const flapH = this.getAvgTearY()
      ctx.translate(0, flapH * eased * 2)
      ctx.globalAlpha = 1 - eased
      this.drawCover(0, 0, W, flapH, 0, 0)
      this.clipAboveTear(t)
      ctx.restore()

      if (t >= 1) {
        this.revealed = true
        this.opts.onRevealed()
      }
      return
    }

    // normal state: draw full cover
    this.drawCover(0, 0, W, H, 0, 0)

    // draw tear line
    if (this.tearPath.length > 0) {
      this.drawTearLine()
    }

    // hint: flash the corner if tear hasn't started
    if (this.tearProgress < 0.05) {
      this.drawCornerHint()
    }
  }

  private drawCover(
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number,
  ): void {
    const { ctx, coverImg } = this
    const W = this.canvas.width
    const H = this.canvas.height

    if (coverImg) {
      ctx.drawImage(coverImg, sx, sy, sw, sh, dx, dy, sw, sh)
    } else {
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = '#d4c9b0'
      ctx.lineWidth = 2
      ctx.fillRect(dx, dy, W, H)
      ctx.strokeRect(dx + 1, dy + 1, W - 2, H - 2)
    }
  }

  private drawTearLine(): void {
    const { ctx, tearPath } = this
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(0, tearPath[0] ?? this.canvas.height * 0.25)
    for (let x = 1; x < tearPath.length; x++) {
      ctx.lineTo(x, tearPath[x])
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()
  }

  private clipAboveTear(_t: number): void {
    const { ctx, tearPath } = this
    const W = this.canvas.width
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(W, 0)
    for (let x = W - 1; x >= 0; x--) {
      ctx.lineTo(x, tearPath[x] ?? this.canvas.height * 0.25)
    }
    ctx.closePath()
    ctx.clip()
  }

  private clipBelowTear(): void {
    const { ctx, tearPath } = this
    const W = this.canvas.width
    const H = this.canvas.height
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(0, tearPath[0] ?? H * 0.25)
    for (let x = 1; x < W; x++) {
      ctx.lineTo(x, tearPath[x] ?? H * 0.25)
    }
    ctx.lineTo(W, H)
    ctx.lineTo(0, H)
    ctx.closePath()
    ctx.clip()
  }

  private drawCornerHint(): void {
    const { ctx } = this
    const pulse = 0.4 + 0.4 * Math.sin(performance.now() / 400)
    ctx.save()
    ctx.beginPath()
    ctx.arc(0, 0, CORNER_RADIUS * 0.8, 0, Math.PI * 0.5)
    ctx.lineTo(0, 0)
    ctx.closePath()
    ctx.fillStyle = `rgba(139, 58, 58, ${pulse * 0.18})`
    ctx.fill()
    // small arrow hint
    ctx.fillStyle = `rgba(139, 58, 58, ${pulse * 0.7})`
    ctx.font = '13px sans-serif'
    ctx.fillText('↘ drag', 6, 20)
    ctx.restore()
  }

  private getAvgTearY(): number {
    if (this.tearPath.length === 0) return this.canvas.height * 0.25
    const sum = this.tearPath.reduce((a, b) => a + b, 0)
    return sum / this.tearPath.length
  }
}

function easeInCubic(t: number): number {
  return t * t * t
}
