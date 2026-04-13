import { exec } from 'node:child_process'

export function openBrowser(url: string): void {
  const platform = process.platform
  const cmd =
    platform === 'darwin' ? `open "${url}"` :
    platform === 'win32'  ? `start "" "${url}"` :
                            `xdg-open "${url}"`
  exec(cmd, (err) => {
    if (err) console.log(`  Open ${url} in your browser to continue.`)
  })
}
