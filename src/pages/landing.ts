export function renderLanding(root: HTMLElement): void {
  root.innerHTML = `
    <div class="landing">
      <div class="landing__envelope">✉</div>
      <h1 class="landing__title">Something is waiting for you</h1>
      <p class="landing__body">
        A friend has prepared a personal message for you.<br>
        Ask them to share the link — it holds the key to open it.
      </p>
    </div>
  `

  const style = document.createElement('style')
  style.textContent = `
    .landing {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.5rem;
      text-align: center;
      padding: 2rem;
      max-width: 480px;
    }
    .landing__envelope {
      font-size: 5rem;
      line-height: 1;
      filter: sepia(0.4);
    }
    .landing__title {
      font-size: 1.75rem;
      font-weight: normal;
      letter-spacing: 0.01em;
      color: var(--ink);
    }
    .landing__body {
      font-size: 1rem;
      line-height: 1.7;
      color: var(--muted);
    }
  `
  document.head.appendChild(style)
}
