# Handoff — Next Steps

This document captures the agreed work items from the last session. Pick these up in order.

---

## Context

This is a "message for you" system: a sender creates an encrypted message locally, commits it to a public GitHub Pages repo, and shares a link. The recipient opens the link and physically rips open a virtual envelope to reveal the message.

The tear animation was just completed in `tear-lab/phase8.html` (Verlet physics, stress-driven breaking, layered audio). It is **standalone and not yet wired into the main viewer**. That is task 1 below.

---

## Task 1 — Port Phase 8 into `src/tear.ts`

**What to do:**  
Replace the contents of `src/tear.ts` with a TypeScript port of the physics + audio engine from `tear-lab/phase8.html`. The class must keep the same public interface so `src/pages/viewer.ts` needs minimal changes.

**Current interface** (must be preserved):
```ts
export interface TearOptions {
  coverUrl: string | null
  jagStyle: 'straight' | 'light' | 'heavy'
  onRevealed: () => void
}

export class TearCanvas {
  constructor(canvas: HTMLCanvasElement, opts: TearOptions)
  resize(w: number, h: number): void
}
```

**What to bring over from `tear-lab/phase8.html`:**
- `Point`, `Constraint` classes
- Full Verlet physics: `integrate`, `updateStress`, `satisfyConstraints`, `satisfyPins`, `relaxConstraint`
- Tear path generation (random walk between `TEAR_MIN_ROW` and `TEAR_MAX_ROW`)
- Pin anchors + stress-driven breaking (`PIN_BREAK_STRESS`)
- `AudioManager` class (all of it — looping slots, blend gains, master ramp)
- Rendering: `computeBackFacing`, `computeLayers`, `filterLayerSpeckle`, `drawQuadLayer`, `blitLayer`, `drawPerforations`
- The letter body area below the tear strip
- Drag handling (find nearest point, break its pin, drag it)

**Audio file path:**  
In the lab the files are `audio/slow.aac` etc. In the main app they must be served from `public/audio/`. Move `tear-lab/audio/*.aac` → `public/audio/` and reference them as:
```ts
const AUDIO_FILES = [
  `${import.meta.env.BASE_URL}audio/slow.aac`,
  `${import.meta.env.BASE_URL}audio/medium.aac`,
  `${import.meta.env.BASE_URL}audio/medium_fast.aac`,
  `${import.meta.env.BASE_URL}audio/fast.aac`,
]
```

**Cover image:**  
The lab draws a plain parchment strip. In the main app, `coverUrl` may be a URL to a template cover PNG. Draw it as the canvas background before the physics strip, or map it as a texture onto the bottom portion (the "letter body" area). Plain white fallback when `coverUrl` is null.

**`onRevealed` callback:**  
Fire it when the tear is complete enough that the letter should show — equivalent to the lab's tear reaching the full width. In the lab there's no explicit "reveal" but in the main app it replaces the canvas with the letter HTML, so it needs to fire exactly once.

**Resize:**  
On `resize(w, h)`, rebuild the physics grid for the new dimensions (re-run grid init).

**Debug overlay:**  
Strip the debug text (`pins: X/Y  perf: X/Y  audio: ...`) — it was useful in the lab but should not appear in production.

---

## Task 2 — Create templates for the three cover images

Three images were dropped into the repo root and need to become proper templates:

| File in root | Template id | Notes |
|---|---|---|
| `hogwarts letter.png` | `hogwarts` | |
| `milka_chocolate.png` | `milka` | |
| `pokemon_booster.png` | `pokemon` | |

**What to do for each:**
1. Create `public/templates/{id}/` directory
2. Move/copy the image there as `cover.png`
3. Create `public/templates/{id}/config.json`:
```json
{
  "id": "{id}",
  "image": "cover.png",
  "ripLine": [],
  "jagStyle": "light"
}
```
The `ripLine` can stay empty for now — the physics system tears at a random horizontal band anyway. A future task can let the user draw a custom rip line in the creation UI and wire it up to constrain where the tear path is seeded.

---

## Task 3 — Clean up the repo root

The root currently has loose files that don't belong there. Tidy it up:

**Audio files in root** (figure out which are used and where they go):
```
fas_rip.aac          ← typo of "fast"? check if duplicate of tear-lab/audio/fast.aac
medium_fast_rip.aac  ← possible duplicate of tear-lab/audio/medium_fast.aac
medium_rip.aac       ← possible duplicate of tear-lab/audio/medium.aac
slow_rip.aac         ← possible duplicate of tear-lab/audio/slow.aac
waveing_1.aac        ← unknown — listen/inspect, may be a waving/hello sound effect
waving_2.aac         ← unknown — same
```
- If they are duplicates of `tear-lab/audio/*.aac`, delete the root copies (the lab files move to `public/audio/` per Task 1).
- If `waveing_1.aac` / `waving_2.aac` are different sounds, move them to `public/audio/` too and note what they are.

**Images:**  
After Task 2, the three `.png` files in root should be removed from root (they live in `public/templates/` now).

**Other root clutter to address:**
- `PREPROMPT.md` — this is a dev context doc, not a README. Either rename to `CLAUDE.md` (Claude Code reads it automatically) or keep as-is. Don't delete.
- `dist/` — generated build output, should be in `.gitignore`. Check and add if missing.
- `node_modules/` — should already be in `.gitignore`. Confirm.

**Goal:** After cleanup, root should look like:
```
.github/
public/
scripts/
src/
tear-lab/
node_modules/     ← gitignored
dist/             ← gitignored
index.html
package.json
package-lock.json
tsconfig.json
vite.config.ts
PREPROMPT.md      (or CLAUDE.md)
```

---

## Order of operations

1. Task 1 (port phase 8) — touches `src/tear.ts`, adds `public/audio/`
2. Task 2 (templates) — adds `public/templates/{hogwarts,milka,pokemon}/`
3. Task 3 (cleanup) — removes loose files from root, verifies `.gitignore`
4. Build & smoke test: `npm run build` should pass; open the viewer in a browser and confirm the tear + audio works with at least one template.
