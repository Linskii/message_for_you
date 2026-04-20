import { decryptMessage } from '../crypto'
import { AudioManager, TearCanvas, preloadImage } from '../tear'
import type { EncryptedMessage, TemplateConfig } from '../types'

export async function renderViewer(root: HTMLElement, hash: string): Promise<void> {
  const colonIdx = hash.indexOf(':')
  const messageId = hash.slice(0, colonIdx)
  const keyB64 = hash.slice(colonIdx + 1)

  root.innerHTML = `<p class="viewer-status">Opening your message…</p>`

  // ── load message ─────────────────────────────────────────────────────────────
  let envelope: EncryptedMessage
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}messages/${messageId}.json`)
    if (!res.ok) throw new Error('not found')
    envelope = (await res.json()) as EncryptedMessage
  } catch {
    showError(root, 'This message could not be found.<br>The link may be invalid or expired.')
    return
  }

  // ── decrypt ──────────────────────────────────────────────────────────────────
  let plaintext: string
  try {
    plaintext = await decryptMessage(envelope, keyB64)
  } catch {
    showError(root, 'Could not decrypt the message.<br>The link may be incomplete or corrupted.')
    return
  }

  // ── load template ─────────────────────────────────────────────────────────────
  let template: TemplateConfig | null = null
  let coverUrl: string | null = null
  if (envelope.templateId) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}templates/${envelope.templateId}/config.json`)
      if (res.ok) {
        template = (await res.json()) as TemplateConfig
        coverUrl = `${import.meta.env.BASE_URL}templates/${envelope.templateId}/${template.image}`
      }
    } catch {
      // non-fatal — fall back to plain white
    }
  }

  // ── build DOM — letter already mounted behind canvas for a seamless reveal ──
  injectStyles()

  root.innerHTML = `
    <div class="viewer">
      <div class="viewer__stage" id="stage">
        <div class="viewer__letter" id="letter">
          <div class="letter__paper">
            <p class="letter__text">${escapeHtml(plaintext)}</p>
          </div>
        </div>
        <div class="viewer__preload" id="preload" aria-live="polite">
          <p class="preload__status" id="preload-status">Preparing your message…</p>
          <div class="preload__bar"><div class="preload__fill" id="preload-fill"></div></div>
          <button class="preload__open" id="preload-open" type="button" hidden>Tap to open</button>
        </div>
        <div class="viewer__hint" id="hint">↙ Tear the letter open</div>
      </div>
    </div>
  `

  const stage = document.getElementById('stage') as HTMLDivElement
  const letter = document.getElementById('letter') as HTMLDivElement
  const preloadEl = document.getElementById('preload') as HTMLDivElement
  const statusEl = document.getElementById('preload-status') as HTMLParagraphElement
  const fillEl = document.getElementById('preload-fill') as HTMLDivElement
  const openBtn = document.getElementById('preload-open') as HTMLButtonElement
  const hintEl = document.getElementById('hint') as HTMLDivElement

  // ── parallel preload: audio bytes + cover image ─────────────────────────────
  const audio = new AudioManager()

  const total = coverUrl ? 2 : 1
  let done = 0
  const bump = (): void => {
    done++
    fillEl.style.width = `${Math.round((done / total) * 100)}%`
  }

  const imgPromise: Promise<HTMLImageElement | null> = coverUrl
    ? preloadImage(coverUrl).then(
        (img) => { bump(); return img },
        (err) => { console.warn('cover preload failed', err); bump(); return null },
      )
    : Promise.resolve(null)

  const bytesPromise = audio.waitForBytes().then(() => { bump() })

  const [coverImg] = await Promise.all([imgPromise, bytesPromise])

  // ── show Tap-to-open button ─────────────────────────────────────────────────
  statusEl.textContent = ''
  openBtn.hidden = false

  const start = async (): Promise<void> => {
    openBtn.disabled = true
    statusEl.textContent = 'Loading…'
    try {
      await audio.unlock()
    } catch (e) {
      console.warn('audio unlock failed', e)
    }
    preloadEl.remove()
    mountCanvas(coverImg)
    hintEl.classList.add('viewer__hint--visible')
  }
  openBtn.addEventListener('click', start, { once: true })

  function mountCanvas(cover: HTMLImageElement | null): void {
    const canvas = document.createElement('canvas')
    canvas.className = 'viewer__canvas'
    canvas.id = 'tear-canvas'
    stage.appendChild(canvas)

    requestAnimationFrame(() => {
      canvas.width = stage.clientWidth || 480
      canvas.height = stage.clientHeight || 680

      const tc = new TearCanvas(canvas, {
        coverImg: cover,
        audio,
        jagStyle: template?.jagStyle ?? 'light',
        onFirstRip: () => {
          // Fade the hint out over 1 second.
          hintEl.classList.add('viewer__hint--fading')
          setTimeout(() => hintEl.remove(), 1100)
        },
        onRevealed: () => {
          canvas.remove()
          letter.classList.add('viewer__letter--revealed')
        },
      })

      window.addEventListener('resize', () => {
        canvas.width = stage.clientWidth
        canvas.height = stage.clientHeight
        tc.resize(canvas.width, canvas.height)
      })
    })
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function showError(root: HTMLElement, msg: string): void {
  root.innerHTML = `<p class="viewer-status viewer-status--error">${msg}</p>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>')
}

function injectStyles(): void {
  const existing = document.getElementById('viewer-styles')
  if (existing) existing.remove()
  const style = document.createElement('style')
  style.id = 'viewer-styles'
  style.textContent = `
    .viewer-status {
      color: var(--muted);
      font-size: 1rem;
      text-align: center;
      line-height: 1.6;
    }
    .viewer-status--error { color: var(--accent); }

    .viewer {
      width: 100%;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }

    .viewer__stage {
      position: relative;
      width: min(480px, 90vw);
      height: min(680px, 85vh);
      border-radius: 4px;
      overflow: visible;
      box-shadow: 0 8px 40px rgba(0,0,0,0.12);
      cursor: grab;
      background: var(--bg);
    }
    .viewer__stage:active { cursor: grabbing; }

    .viewer__canvas {
      position: absolute;
      inset: 0;
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
      z-index: 2;
      border-radius: 4px;
    }

    .viewer__letter {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: safe center;
      justify-content: safe center;
      background: var(--bg);
      padding: 2rem;
      overflow-y: auto;
      opacity: 0.0;
      transform: translateY(6px);
      transition: opacity 0.5s ease 0.05s, transform 0.5s ease 0.05s;
      z-index: 1;
      border-radius: 4px;
    }
    .viewer__letter--revealed {
      opacity: 1;
      transform: translateY(0);
    }

    .letter__paper {
      background: #fff;
      border: 1px solid #d4c9b0;
      border-radius: 2px;
      padding: 2.5rem 3rem;
      max-width: 100%;
      box-shadow: 0 2px 16px rgba(0,0,0,0.06);
    }

    .letter__text {
      font-family: 'Georgia', serif;
      font-size: 1.1rem;
      line-height: 1.9;
      color: var(--ink);
    }

    .viewer__preload {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1.2rem;
      padding: 2rem;
      background: var(--bg);
      z-index: 3;
      border-radius: 4px;
    }
    .preload__status {
      color: var(--muted);
      font-size: 0.95rem;
      margin: 0;
      text-align: center;
      min-height: 1.4em;
    }
    .preload__bar {
      width: min(220px, 70%);
      height: 4px;
      background: rgba(0,0,0,0.08);
      border-radius: 2px;
      overflow: hidden;
    }
    .preload__fill {
      width: 0%;
      height: 100%;
      background: var(--accent, #c0504d);
      transition: width 0.25s ease;
    }
    .preload__open {
      font: inherit;
      font-size: 1rem;
      padding: 0.7rem 1.6rem;
      border-radius: 999px;
      border: 1px solid rgba(0,0,0,0.15);
      background: #fff;
      color: var(--ink);
      cursor: pointer;
      box-shadow: 0 2px 10px rgba(0,0,0,0.06);
      transition: transform 0.1s ease, box-shadow 0.15s ease;
    }
    .preload__open:hover { box-shadow: 0 3px 14px rgba(0,0,0,0.1); }
    .preload__open:active { transform: translateY(1px); }
    .preload__open:disabled { opacity: 0.6; cursor: default; }

    .viewer__hint {
      position: absolute;
      top: -1.6rem;
      left: 0;
      color: #c0504d;
      font-size: 0.85rem;
      font-weight: 500;
      letter-spacing: 0.01em;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.5s ease;
      z-index: 4;
    }
    .viewer__hint--visible { opacity: 1; }
    .viewer__hint--fading { opacity: 0; }
  `
  document.head.appendChild(style)
}
