import { decryptMessage } from '../crypto';
import { TearCanvas } from '../tear';
export async function renderViewer(root, hash) {
    const colonIdx = hash.indexOf(':');
    const messageId = hash.slice(0, colonIdx);
    const keyB64 = hash.slice(colonIdx + 1);
    root.innerHTML = `<p class="viewer-status">Opening your message…</p>`;
    // ── load message ─────────────────────────────────────────────────────────────
    let envelope;
    try {
        const res = await fetch(`${import.meta.env.BASE_URL}messages/${messageId}.json`);
        if (!res.ok)
            throw new Error('not found');
        envelope = (await res.json());
    }
    catch {
        showError(root, 'This message could not be found.<br>The link may be invalid or expired.');
        return;
    }
    // ── decrypt ──────────────────────────────────────────────────────────────────
    let plaintext;
    try {
        plaintext = await decryptMessage(envelope, keyB64);
    }
    catch {
        showError(root, 'Could not decrypt the message.<br>The link may be incomplete or corrupted.');
        return;
    }
    // ── load template ─────────────────────────────────────────────────────────────
    let template = null;
    let coverUrl = null;
    if (envelope.templateId) {
        try {
            const res = await fetch(`${import.meta.env.BASE_URL}templates/${envelope.templateId}/config.json`);
            if (res.ok) {
                template = (await res.json());
                coverUrl = `${import.meta.env.BASE_URL}templates/${envelope.templateId}/${template.image}`;
            }
        }
        catch {
            // non-fatal — fall back to plain white
        }
    }
    // ── build DOM — letter already mounted behind canvas for a seamless reveal ──
    injectStyles();
    root.innerHTML = `
    <div class="viewer">
      <div class="viewer__stage" id="stage">
        <div class="viewer__letter" id="letter">
          <div class="letter__paper">
            <p class="letter__text">${escapeHtml(plaintext)}</p>
          </div>
        </div>
        <canvas class="viewer__canvas" id="tear-canvas"></canvas>
      </div>
    </div>
  `;
    const canvas = document.getElementById('tear-canvas');
    const stage = document.getElementById('stage');
    const letter = document.getElementById('letter');
    requestAnimationFrame(() => {
        canvas.width = stage.clientWidth || 480;
        canvas.height = stage.clientHeight || 680;
        const tc = new TearCanvas(canvas, {
            coverUrl,
            jagStyle: template?.jagStyle ?? 'light',
            onRevealed: () => {
                // Canvas has slid its content off-screen; remove it and let the
                // already-mounted letter breathe with a gentle fade-up.
                canvas.remove();
                letter.classList.add('viewer__letter--revealed');
            },
        });
        window.addEventListener('resize', () => {
            canvas.width = stage.clientWidth;
            canvas.height = stage.clientHeight;
            tc.resize(canvas.width, canvas.height);
        });
    });
}
// ── helpers ───────────────────────────────────────────────────────────────────
function showError(root, msg) {
    root.innerHTML = `<p class="viewer-status viewer-status--error">${msg}</p>`;
}
function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\n/g, '<br>');
}
function injectStyles() {
    const existing = document.getElementById('viewer-styles');
    if (existing)
        existing.remove();
    const style = document.createElement('style');
    style.id = 'viewer-styles';
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
      overflow: hidden;
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
    }

    .viewer__letter {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg);
      padding: 2rem;
      overflow-y: auto;
      opacity: 0.0;
      transform: translateY(6px);
      transition: opacity 0.5s ease 0.05s, transform 0.5s ease 0.05s;
      z-index: 1;
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
  `;
    document.head.appendChild(style);
}
