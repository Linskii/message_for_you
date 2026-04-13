import { renderLanding } from './pages/landing'
import { renderViewer } from './pages/viewer'

function route(): void {
  const hash = window.location.hash.slice(1) // strip leading #
  const app = document.getElementById('app')!

  if (hash && hash.includes(':')) {
    renderViewer(app, hash)
  } else {
    renderLanding(app)
  }
}

window.addEventListener('hashchange', route)
route()
