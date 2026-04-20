# Message For You

A tiny, private messaging system built on GitHub Pages. Write someone a secret note, encrypt it in your browser, and share a link — the recipient tears open a virtual envelope to reveal it.

**No server. No accounts. No plaintext ever leaves your machine.**

---

## How It Works

The security model is simple and auditable:

1. You write a message locally and click **Generate link**
2. The message is encrypted with AES-GCM (256-bit) — entirely in Node.js on your machine
3. The encrypted blob is saved to `public/messages/{uuid}.json`
4. You push to GitHub — the repo only ever holds ciphertext
5. The **decryption key lives exclusively in the URL fragment** (`#uuid:key`), which browsers never send to any server
6. The recipient opens the link, the browser fetches the blob and decrypts it locally, and they get to physically tear open the envelope

```
your machine                    GitHub                      recipient's browser
─────────────────────────────────────────────────────────────────────────────
write message
    │
    ▼
encrypt (AES-GCM)  ──── push ciphertext ────► GitHub Pages CDN
    │                                                │
    ▼                                                ▼
share URL ──────────────────────────────────► fetch ciphertext
https://…/#uuid:key                                  │
                                              decrypt with key
                                              (key never leaves URL fragment)
                                                     │
                                                     ▼
                                              tear open envelope ✦
                                              read message
```

GitHub only ever sees an opaque JSON blob. Even if the repo is public, nobody without the link can read anything.

---

## Quick Start

**Prerequisites:** Node.js 22+, a GitHub account, and this repo forked/cloned.

### 1. Fork and configure

Fork this repository, then update `package.json` to point to your GitHub Pages URL:

```json
"homepage": "https://YOUR_USERNAME.github.io/message_for_you"
```

### 2. Enable GitHub Pages

In your fork's **Settings → Pages**, set the source to **GitHub Actions**.

The workflow at [.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds and deploys on every push to `main`.

### 3. Install dependencies

```bash
npm install
```

### 4. Create your first message

```bash
npm run create
```

This opens a local web UI at `http://localhost:4321`. Compose your message, pick a template (optional), click **Generate link** — done. The URL is ready to copy and send.

### 5. Publish

```bash
git add public/messages/
git commit -m "add message"
git push
```

GitHub Actions builds and deploys in about 30 seconds. Share the link.

---

## Creating a Message

Run the creation server:

```bash
npm run create
```

The **Compose** tab has everything you need:

| Field | Description |
|---|---|
| Message | The plaintext you want to encrypt. Supports any Unicode. |
| Template | Optional visual skin shown as the envelope cover. |

Click **Generate link** — the server encrypts locally, writes `public/messages/{uuid}.json`, and shows you a shareable URL like:

```
https://YOUR_USERNAME.github.io/message_for_you/#a3f2…:dGhpcyBpcyB0aGU…
```

The part after `#` is `uuid:base64-key`. The key never touches GitHub.

After generating, commit and push the new file under `public/messages/`. The recipient can open the link as soon as the Pages deployment finishes.

---

## Creating a Template

Templates are visual skins — a cover image that gets torn in two when the recipient interacts with the envelope.

### Option A — via the UI

1. Run `npm run create` and switch to the **Templates** tab
2. Enter a template **name** (lowercase, no spaces — becomes the folder name)
3. Upload a cover image (PNG or JPG)
4. Optionally draw a **rip line** by clicking points on the canvas, double-click to finish
5. Choose a **jag style**: `straight`, `light`, or `heavy`
6. Click **Save template**

The template is immediately available in the Compose dropdown.

### Option B — manually

Create the following structure under `public/templates/`:

```
public/templates/
└── my-template/
    ├── cover.png        ← your cover image (any resolution, landscape works best)
    └── config.json
```

`config.json` format:

```json
{
  "id": "my-template",
  "image": "cover.png",
  "ripLine": [],
  "jagStyle": "light"
}
```

`jagStyle` options: `"straight"` · `"light"` · `"heavy"`

Commit the new folder alongside your message file and push.

### Built-in templates

| Name | Description |
|---|---|
| `hogwarts` | Hogwarts acceptance letter aesthetic |
| `milka` | Milka chocolate wrapper |
| `pokemon` | Pokémon card style |
| `tumblr` | Tumblr post aesthetic |

---

## Repository Structure

```
message_for_you/
├── public/
│   ├── messages/               ← encrypted message blobs (one JSON per message)
│   ├── templates/              ← visual skins
│   │   └── {name}/
│   │       ├── cover.png
│   │       └── config.json
│   └── audio/                  ← rip sound effects (AAC, blended by tear speed)
├── src/                        ← Vite + TypeScript viewer (GitHub Pages)
│   ├── main.ts                 ← URL router (#id:key → viewer, else landing)
│   ├── crypto.ts               ← AES-GCM via Web Crypto API
│   ├── tear.ts                 ← Verlet physics tear animation + audio engine
│   ├── types.ts                ← EncryptedMessage, TemplateConfig interfaces
│   └── pages/
│       ├── viewer.ts           ← fetch → decrypt → animate → reveal
│       └── landing.ts          ← landing page for bare URL visits
├── scripts/
│   ├── crypto-node.ts          ← Node.js AES-GCM (mirrors src/crypto.ts)
│   └── server/
│       ├── index.ts            ← HTTP server on :4321 (message creation)
│       └── ui.html             ← compose + template editor UI
├── .github/workflows/
│   └── deploy.yml              ← build + deploy to GitHub Pages on push to main
├── package.json
└── vite.config.ts
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Viewer | Vite + TypeScript, no framework |
| Animation | Canvas 2D + Verlet physics (custom, `tear.ts`) |
| Audio | AAC loops blended by tear velocity |
| Encryption | AES-GCM 256-bit — Web Crypto API (browser) / `node:crypto` (creation) |
| Hosting | GitHub Pages via GitHub Actions |
| Creation tool | Node.js HTTP server + vanilla JS UI |

---

## Security Notes

- The decryption key is **only** in the URL fragment. Fragments are never sent in HTTP requests.
- If you share the link over a logged channel (email, iMessage), anyone with access to that channel can decrypt the message. The security guarantee is only as strong as how you share the link.
- Messages are never deleted from the repo. If you want to revoke access, delete the message file and push.
- The repo can be public — ciphertext without the key is unreadable.
