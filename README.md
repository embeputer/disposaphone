# Disposaphone

> Your phone, but disposable.

A small, aesthetic web app that turns any phone into a single-use camera. Pick
how big a roll you want (4 / 8 / 12 / 24 shots), take square photos — _you
can't preview them_ — and when the roll runs out, your photos are "developed"
into a single photobooth-style strip you can save.

No accounts. No upload. Everything runs in your browser, on your device.

## Features

- **Dark cocoa + buttery yellow** aesthetic — `#1e0904` everywhere, warm cream
  ink, glowing yellow accents. Set in a single typeface (Fraunces variable)
  with the rounded `SOFT` axis dialed up for a bubbly, charming feel.
- 1:1 square viewfinder with a moody dark-plastic camera body, an italic
  "DISPOSAPHONE · 35MM · ASA 400" label, glowing yellow indicator dot, an
  LCD-style yellow shot counter, and a chunky **buttery-yellow shutter
  button** as the hero element.
- Hidden roll — taken photos are not shown back, only a counter ticks down.
- **Vintage camera filter** baked into every shot:
  - Aggressive black lift for that classic faded toe
  - Cross-process tone (cool/green shadows, warm midtones, orange highlights)
  - **Halation glow** — bright pixels bloom warm/orange like real film
  - **Light leak** — a soft warm wedge from a rotating corner per shot
  - Vignette and chunky grain with a warm bias
  - **Date stamp burn-in** in the bottom-right corner (`'26 4 26`-style),
    glowing orange like a 90s auto-date point-and-shoot
- Automatic recovery — if the tab is closed mid-roll, you can pick up where
  you left off (photos are stored locally in `localStorage`).
- "Developing" animation with a glowing yellow safelight, amber progress bar,
  and rotating darkroom status messages. Then a composed photobooth strip on
  cream paper with perforations, an italic "disposaphone" header, the date,
  and white-bordered photos.
- Save the strip as a JPEG, share via the Web Share API on supported devices.
- Front/rear camera switch.
- Synthesized shutter click (no audio assets needed) and a haptic buzz on
  mobile.

## Run it locally

The app is plain HTML/CSS/JS — no build step. But cameras only work over
HTTPS or `localhost`, so you do need a local server (opening the file with
`file://` won't grant camera permission).

Pick any of these:

```bash
# Python (built-in)
python -m http.server 5173

# Node (no install)
npx serve .

# PHP
php -S localhost:5173
```

Then open <http://localhost:5173> on your computer.

### Open it on your phone (during development)

If your computer's local IP is e.g. `192.168.1.42`, open
`http://192.168.1.42:5173` from your phone's browser. iOS Safari and Android
Chrome both support camera access on `http://` only when the host is
`localhost`; for other hostnames you need HTTPS. Easiest workarounds:

- Tunnel with `npx localtunnel --port 5173` or
  `cloudflared tunnel --url http://localhost:5173`
- Or just deploy to Vercel (see below) — five-minute round trip and you get
  a real HTTPS URL.

## Deploy to Vercel

Vercel auto-detects this as a static site (no build step) and serves it from
its global edge with HTTPS by default — which is exactly what `getUserMedia`
needs. The included `vercel.json` sets a few useful headers:

- `Permissions-Policy: camera=(self)` — explicitly allow the camera on the
  same origin
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` — don't let the page be embedded in iframes
- `cleanUrls: true` — `/` instead of `/index.html`

### Option A — Vercel CLI (fastest)

```bash
# from inside this folder
npx vercel              # first run links the project, deploys a preview
npx vercel --prod       # promote to production
```

The CLI will ask "Set up and deploy?" → yes, "Which scope?" → your account,
"Link to existing project?" → no, then it gives you a URL.

### Option B — GitHub + Vercel dashboard

1. Create a GitHub repo and push this folder to it:

   ```bash
   git add .
   git commit -m "initial disposaphone"
   git remote add origin <your-github-repo-url>
   git push -u origin main
   ```

2. Go to [vercel.com/new](https://vercel.com/new), pick the repo, click
   **Deploy**. Done. Future pushes to `main` deploy automatically.

### After it's live

- Visit the URL on your phone. The first time you tap the shutter, the
  browser will ask for camera permission. Allow it once and it's remembered.
- Add the page to your phone's home screen for an app-like icon.
- The favicon is `favicon.svg` — a tiny dark cocoa tile with a yellow
  shutter outline. Replace it with your own if you fork this.

## Files

- `index.html` — markup for the four screens (intro, camera, developing,
  strip)
- `styles.css` — all visual styling, animations, the camera body, the
  EV-scale slider, and the outlined shutter
- `app.js` — camera, capture pipeline (vintage filter), develop animation,
  strip composition
- `favicon.svg` — small SVG icon
- `vercel.json` — deploy config (headers, clean URLs)
- `.gitignore` — standard ignores

No dependencies, no bundler.

## Tweaks you might want

In `app.js`, top of the file:

- `PHOTO_SIZE` — capture resolution per photo (default 1080)
- `PHOTO_QUALITY` — JPEG quality 0–1 (default 0.82)
- `STRIP` — strip layout: width, photo size, paddings, colors

Storage limit note: `localStorage` is ~5 MB on most browsers. With defaults
this comfortably fits a 24-shot roll. If you raise `PHOTO_SIZE` or
`PHOTO_QUALITY`, you may need to switch to IndexedDB.

## Browser support

- iOS Safari 14+
- Android Chrome / any modern Chromium
- Desktop Chrome / Firefox / Safari

Requires `getUserMedia` and `<canvas>`. Web Share with files (the optional
share button) needs iOS 15+ / Android Chrome.
