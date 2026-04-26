/* =========================================================
   Disposaphone — app logic
   - getUserMedia camera with square viewfinder
   - capture pipeline: square crop + warm film grade + vignette + grain
   - photos hidden until the roll is finished, then composed
     into a photobooth-style strip
   ========================================================= */

(() => {
  "use strict";

  /* ---------- constants ---------- */

  // working resolution per photo (kept reasonable so 24 photos fit in
  // localStorage which is ~5MB on most browsers)
  const PHOTO_SIZE = 1080;
  const PHOTO_QUALITY = 0.82;
  const STORAGE_KEY = "disposaphone:roll:v1";

  // strip layout (in canvas px; the canvas is downscaled visually)
  const STRIP = {
    width: 720,
    photoSize: 640,
    sidePad: 40,         // (width - photoSize) / 2
    photoBorder: 8,      // white border around each photo
    gap: 28,             // gap between photo slots
    headerH: 140,
    footerH: 110,
    bg: "#f5e6c4",
    paper: "#faf0d4",
    ink: "#2a120c",
    accent: "#b5891f",   // mustard yellow, on-theme
  };

  /* ---------- DOM ---------- */

  const $ = (sel) => document.querySelector(sel);

  const screens = {
    intro: $('[data-screen="intro"]'),
    camera: $('[data-screen="camera"]'),
    developing: $('[data-screen="developing"]'),
    strip: $('[data-screen="strip"]'),
  };

  const els = {
    rollSliderRoot: $("#rollSliderRoot"),
    rollSlider: $("#rollSlider"),
    rollDisplayNum: $("#rollDisplayNum"),
    rollDisplaySub: $("#rollDisplaySub"),
    rollRail: $("#rollRail"),
    rollNums: $("#rollNums"),
    startBtn: $("#startBtn"),
    resumeNotice: $("#resumeNotice"),
    resumeBtn: $("#resumeBtn"),
    discardBtn: $("#discardBtn"),

    video: $("#video"),
    flash: $("#flash"),
    counter: $("#counter"),
    shutterBtn: $("#shutterBtn"),
    flipBtn: $("#flipBtn"),
    endRollBtn: $("#endRollBtn"),
    cameraLoading: $("#cameraLoading"),
    cameraError: $("#cameraError"),
    cameraErrorDetail: $("#cameraErrorDetail"),
    retryBtn: $("#retryBtn"),
    cameraHint: $("#cameraHint"),

    developingSub: $("#developingSub"),
    developingBar: document.querySelector(".developing__bar"),

    stripCanvas: $("#stripCanvas"),
    downloadBtn: $("#downloadBtn"),
    shareBtn: $("#shareBtn"),
    newRollBtn: $("#newRollBtn"),
  };

  /* ---------- state ---------- */

  /** @typedef {{ rollSize: number, photos: string[], facingMode: "user"|"environment" }} Roll */

  const state = {
    /** @type {Roll | null} */
    roll: null,
    /** @type {MediaStream | null} */
    stream: null,
    capturing: false,
    /** @type {Blob | null} */
    stripBlob: null,
    stripFilename: "",
  };

  /* ---------- storage ---------- */

  function loadRoll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed.rollSize !== "number" ||
        !Array.isArray(parsed.photos)
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function saveRoll() {
    if (!state.roll) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.roll));
    } catch (err) {
      // storage full — surface a gentle warning but keep going in memory
      console.warn("[disposaphone] could not persist roll:", err);
      els.cameraHint.textContent =
        "memory's full — don't refresh or you'll lose your shots";
    }
  }

  function clearStoredRoll() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  /* ---------- screen routing ---------- */

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el.classList.toggle("is-active", key === name);
    });
  }

  /* ---------- intro / roll slider ---------- */

  const ROLL_VALUES = [4, 8, 12, 24];
  const ROLL_LABELS = ["a strip", "classic", "a night out", "a whole roll"];
  const ROLL_DEFAULT_IDX = 1;

  let currentRollIdx = ROLL_DEFAULT_IDX;

  function setRollIdx(idx, opts) {
    const animate = !opts || opts.animate !== false;
    const haptic = opts && opts.haptic;
    idx = Math.max(0, Math.min(ROLL_VALUES.length - 1, idx));

    const changed = idx !== currentRollIdx;
    currentRollIdx = idx;

    const value = ROLL_VALUES[idx];
    const label = ROLL_LABELS[idx];
    const p = (idx / (ROLL_VALUES.length - 1)) * 100;

    if (els.rollSlider.valueAsNumber !== idx) {
      els.rollSlider.value = String(idx);
    }
    // --p drives the indicator + active-num positioning
    els.rollSliderRoot.style.setProperty("--p", `${p}%`);
    els.rollSlider.setAttribute("aria-valuetext", `${value}, ${label}`);

    els.rollDisplayNum.textContent = String(value);
    els.rollDisplaySub.textContent = label;

    els.rollNums.querySelectorAll(".roll-slider__num").forEach((n, i) => {
      n.classList.toggle("is-active", i === idx);
    });

    if (changed && animate) {
      const num = els.rollDisplayNum;
      num.classList.remove("is-popping");
      void num.offsetWidth;
      num.classList.add("is-popping");
    }
    if (changed && haptic) vibrate(8);
  }

  function initIntro() {
    setRollIdx(ROLL_DEFAULT_IDX, { animate: false });

    // native input event (drag, keyboard arrows)
    els.rollSlider.addEventListener("input", () => {
      setRollIdx(els.rollSlider.valueAsNumber, { haptic: true });
    });

    // click-to-jump anywhere on the slider — measure relative to the
    // visual rail so the indicator lands where the user tapped
    els.rollSlider.addEventListener("pointerdown", (e) => {
      const rect = els.rollRail.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width)
      );
      const idx = Math.round(ratio * (ROLL_VALUES.length - 1));
      setRollIdx(idx, { haptic: true });
    });

    // tap a number label to jump to it
    els.rollNums.querySelectorAll(".roll-slider__num").forEach((num) => {
      num.style.pointerEvents = "auto";
      num.style.cursor = "pointer";
      num.addEventListener("click", () => {
        const i = parseInt(num.dataset.i ?? "1", 10);
        setRollIdx(i, { haptic: true });
        els.rollSlider.focus();
      });
    });

    els.startBtn.addEventListener("click", () => {
      state.roll = {
        rollSize: ROLL_VALUES[currentRollIdx],
        photos: [],
        facingMode: "environment",
      };
      saveRoll();
      enterCamera();
    });

    // resume?
    const existing = loadRoll();
    if (existing && existing.photos.length > 0 && existing.photos.length < existing.rollSize) {
      els.resumeNotice.hidden = false;
      els.resumeBtn.addEventListener("click", () => {
        state.roll = existing;
        enterCamera();
      });
      els.discardBtn.addEventListener("click", () => {
        clearStoredRoll();
        els.resumeNotice.hidden = true;
      });
    }
  }

  /* ---------- camera ---------- */

  async function enterCamera() {
    showScreen("camera");
    updateCounter();
    await startStream();
  }

  async function startStream() {
    stopStream();
    showCameraLoading(true);
    showCameraError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      showCameraError(
        "your browser doesn't support camera access. try Safari or Chrome on a phone."
      );
      return;
    }

    const facing = state.roll?.facingMode ?? "environment";

    /** @type {MediaStreamConstraints} */
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1920 },
      },
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.stream = stream;
      els.video.srcObject = stream;
      els.video.classList.toggle("is-back", facing === "environment");

      await new Promise((resolve) => {
        if (els.video.readyState >= 2) return resolve(null);
        els.video.onloadedmetadata = () => resolve(null);
      });
      try {
        await els.video.play();
      } catch {
        // autoplay can be cranky on some devices, ignore — we have user gesture later
      }

      showCameraLoading(false);
      els.shutterBtn.disabled = false;
    } catch (err) {
      const detail =
        err && typeof err === "object" && "message" in err
          ? String(err.message)
          : "unknown error";
      let friendly = "we couldn't open the camera.";
      if (err && /NotAllowed|Permission/i.test(err.name || "")) {
        friendly =
          "camera permission was blocked. enable it in your browser settings and try again.";
      } else if (err && /NotFound/i.test(err.name || "")) {
        friendly = "no camera found on this device.";
      } else if (err && /NotReadable|TrackStart/i.test(err.name || "")) {
        friendly =
          "the camera is busy. close other apps using it and try again.";
      } else if (location.protocol !== "https:" && location.hostname !== "localhost") {
        friendly =
          "camera access requires HTTPS. open this page over https:// or on localhost.";
      }
      showCameraError(friendly, detail);
    }
  }

  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    els.video.srcObject = null;
  }

  function showCameraLoading(loading) {
    els.cameraLoading.classList.toggle("is-hidden", !loading);
  }

  function showCameraError(msg, detail) {
    if (msg) {
      els.cameraError.hidden = false;
      els.cameraError.querySelector("p").textContent = msg;
      els.cameraErrorDetail.textContent = detail || "";
      showCameraLoading(false);
      els.shutterBtn.disabled = true;
    } else {
      els.cameraError.hidden = true;
    }
  }

  function bindCameraControls() {
    els.shutterBtn.addEventListener("click", onShutter);
    els.flipBtn.addEventListener("click", async () => {
      if (!state.roll) return;
      state.roll.facingMode =
        state.roll.facingMode === "environment" ? "user" : "environment";
      saveRoll();
      await startStream();
    });
    els.endRollBtn.addEventListener("click", () => {
      if (!state.roll) return;
      if (state.roll.photos.length === 0) {
        if (
          confirm(
            "you haven't taken any shots yet. put the camera down?"
          )
        ) {
          clearStoredRoll();
          state.roll = null;
          stopStream();
          showScreen("intro");
        }
        return;
      }
      finishRoll();
    });
    els.retryBtn.addEventListener("click", () => startStream());
  }

  /* ---------- shutter ---------- */

  function updateCounter() {
    if (!state.roll) {
      els.counter.textContent = "--";
      return;
    }
    const left = state.roll.rollSize - state.roll.photos.length;
    els.counter.textContent = String(left).padStart(2, "0");
  }

  async function onShutter() {
    if (state.capturing || !state.roll) return;
    if (state.roll.photos.length >= state.roll.rollSize) return;
    if (!state.stream) return;

    state.capturing = true;
    els.shutterBtn.disabled = true;

    try {
      flashEffect();
      shutterPulse();
      shutterClick();
      vibrate(30);

      const dataUrl = await capturePhoto();
      state.roll.photos.push(dataUrl);
      saveRoll();
      updateCounter();

      if (state.roll.photos.length >= state.roll.rollSize) {
        finishRoll();
        return;
      }
    } catch (err) {
      console.error("[disposaphone] capture failed:", err);
    } finally {
      // small delay before re-enabling, more "mechanical"
      setTimeout(() => {
        state.capturing = false;
        if (state.roll && state.roll.photos.length < state.roll.rollSize) {
          els.shutterBtn.disabled = false;
        }
      }, 350);
    }
  }

  function flashEffect() {
    els.flash.classList.remove("is-flashing");
    // restart animation
    void els.flash.offsetWidth;
    els.flash.classList.add("is-flashing");
  }

  function shutterPulse() {
    els.shutterBtn.classList.remove("is-firing");
    void els.shutterBtn.offsetWidth;
    els.shutterBtn.classList.add("is-firing");
  }

  function vibrate(ms) {
    if (navigator.vibrate) {
      try { navigator.vibrate(ms); } catch { /* ignore */ }
    }
  }

  // a tiny synthesized "click" using web audio — no asset needed
  let audioCtx = null;
  function shutterClick() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const t = audioCtx.currentTime;

      // mechanical click: short noise burst + low thump
      const noise = audioCtx.createBufferSource();
      const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.05, audioCtx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      noise.buffer = buf;
      const noiseGain = audioCtx.createGain();
      noiseGain.gain.setValueAtTime(0.18, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      noise.connect(noiseGain).connect(audioCtx.destination);
      noise.start(t);
      noise.stop(t + 0.07);

      const osc = audioCtx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(220, t);
      osc.frequency.exponentialRampToValueAtTime(80, t + 0.05);
      const oscGain = audioCtx.createGain();
      oscGain.gain.setValueAtTime(0.12, t);
      oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      osc.connect(oscGain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.07);
    } catch {
      // ignore
    }
  }

  /* ---------- capture pipeline (vintage camera filter) ---------- */

  async function capturePhoto() {
    const video = els.video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) throw new Error("video not ready");

    // 1) draw center-cropped square from the video at high res
    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2;
    const sy = (vh - side) / 2;

    const canvas = document.createElement("canvas");
    canvas.width = PHOTO_SIZE;
    canvas.height = PHOTO_SIZE;
    const ctx = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!ctx) throw new Error("2d context unavailable");

    if (state.roll?.facingMode === "user") {
      ctx.translate(PHOTO_SIZE, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // vintage filter pipeline
    applyVintageGrade(ctx, PHOTO_SIZE, PHOTO_SIZE);
    applyHalation(ctx, PHOTO_SIZE, PHOTO_SIZE);
    applyLightLeak(ctx, PHOTO_SIZE, PHOTO_SIZE, leakCornerForRoll());
    applyVignette(ctx, PHOTO_SIZE, PHOTO_SIZE, 0.55);
    applyGrain(ctx, PHOTO_SIZE, PHOTO_SIZE, 16);
    drawDateStamp(ctx, PHOTO_SIZE, PHOTO_SIZE, new Date());

    return canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
  }

  // ----- vintage color grade -----
  // - aggressive black lift (faded look)
  // - cross-process: cool/green shadows, warm midtones, orange highlights
  // - boost saturation in warm channels, slight desat overall
  function applyVintageGrade(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i];
      let g = d[i + 1];
      let b = d[i + 2];

      // luminance for masks
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const t = lum / 255;                     // 0..1
      const shadowMask = 1 - smoothstep(0.0, 0.5, t);
      const highMask   = smoothstep(0.55, 1.0, t);

      // gentle desat overall, then we re-tint
      const desat = 0.22;
      r = r + (lum - r) * desat;
      g = g + (lum - g) * desat;
      b = b + (lum - b) * desat;

      // shadows lean cool/green-teal (very classic film toe)
      r += -10 * shadowMask;
      g +=   8 * shadowMask;
      b +=   4 * shadowMask;

      // midtones warm overall
      r *= 1.06;
      g *= 1.01;
      b *= 0.90;

      // highlights lean orange/red (kodak-ish bloom)
      r += 12 * highMask;
      g +=  4 * highMask;
      b += -10 * highMask;

      // strong black lift -> faded look + slight yellow in the toe
      r = liftToe(r, 22, 1.4);
      g = liftToe(g, 18, 1.2);
      b = liftToe(b, 12, 1.0);

      // soft-knee highlights so nothing clips harshly
      r = softKnee(r);
      g = softKnee(g);
      b = softKnee(b);

      d[i]     = clamp(r);
      d[i + 1] = clamp(g);
      d[i + 2] = clamp(b);
    }
    ctx.putImageData(img, 0, 0);
  }

  function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function liftToe(v, lift, gamma) {
    // raise the floor to `lift`, then apply gentle gamma
    const norm = v / 255;
    const lifted = norm * (1 - lift / 255) + lift / 255;
    return Math.pow(lifted, 1 / gamma) * 255;
  }

  function softKnee(v) {
    if (v <= 215) return v;
    const t = (v - 215) / 40;
    return 215 + (1 - Math.exp(-t * 1.4)) * 30;
  }

  function clamp(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  // ----- halation: bright pixels glow warm/orange (film bloom) -----
  function applyHalation(ctx, w, h) {
    // copy current canvas to a temp, mask to highlights tinted orange
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.drawImage(ctx.canvas, 0, 0);

    const id = tctx.getImageData(0, 0, w, h);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const t = Math.max(0, lum - 170) / 85; // 170-255 -> 0-1
      const mask = Math.min(1, t * t);
      // warm orange tint
      d[i]     = 255;
      d[i + 1] = 130 + 40 * mask;
      d[i + 2] = 60  + 20 * mask;
      d[i + 3] = Math.round(mask * 200);
    }
    tctx.putImageData(id, 0, 0);

    // blur the highlights via canvas filter
    const blurred = document.createElement("canvas");
    blurred.width = w; blurred.height = h;
    const bctx = blurred.getContext("2d");
    if ("filter" in bctx) {
      bctx.filter = `blur(${Math.round(w * 0.025)}px)`;
      bctx.drawImage(tmp, 0, 0);
    } else {
      // fallback: cheap fake-blur via downscale + upscale
      const tiny = document.createElement("canvas");
      tiny.width = Math.round(w / 12); tiny.height = Math.round(h / 12);
      tiny.getContext("2d").drawImage(tmp, 0, 0, tiny.width, tiny.height);
      bctx.imageSmoothingEnabled = true;
      bctx.imageSmoothingQuality = "high";
      bctx.drawImage(tiny, 0, 0, w, h);
    }

    // composite glow
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.55;
    ctx.drawImage(blurred, 0, 0);
    ctx.restore();
  }

  // ----- light leak: warm wedge from a corner -----
  function leakCornerForRoll() {
    // deterministic per-shot rotation so a single roll feels coherent but varied
    const idx = (state.roll?.photos.length ?? 0) % 4;
    return ["top-right", "bottom-left", "top-left", "bottom-right"][idx];
  }

  function applyLightLeak(ctx, w, h, corner) {
    const positions = {
      "top-left":     [w * 0.05, h * 0.05],
      "top-right":    [w * 0.95, h * 0.06],
      "bottom-left":  [w * 0.06, h * 0.96],
      "bottom-right": [w * 0.95, h * 0.95],
    };
    const [cx, cy] = positions[corner] || positions["top-right"];

    const grad = ctx.createRadialGradient(cx, cy, w * 0.03, cx, cy, w * 0.65);
    grad.addColorStop(0,    "rgba(255, 210, 110, 0.55)");
    grad.addColorStop(0.25, "rgba(255, 150, 60, 0.32)");
    grad.addColorStop(0.55, "rgba(220, 80, 40, 0.14)");
    grad.addColorStop(1,    "rgba(0, 0, 0, 0)");

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  function applyVignette(ctx, w, h, strength) {
    const s = strength ?? 0.42;
    const grad = ctx.createRadialGradient(
      w / 2, h / 2, w * 0.32,
      w / 2, h / 2, w * 0.74
    );
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, `rgba(10, 4, 0, ${s})`);
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  function applyGrain(ctx, w, h, intensity) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // chunkier per-channel grain w/ subtle warm bias
      const n = (Math.random() - 0.5) * intensity;
      d[i]     = clamp(d[i]     + n * 1.10);
      d[i + 1] = clamp(d[i + 1] + n * 0.95);
      d[i + 2] = clamp(d[i + 2] + n * 0.80);
    }
    ctx.putImageData(img, 0, 0);
  }

  // ----- date stamp (orange burn-in, bottom-right) -----
  function drawDateStamp(ctx, w, h, date) {
    const yy = String(date.getFullYear()).slice(-2);
    const mo = date.getMonth() + 1;
    const dd = date.getDate();
    const text = `'${yy} ${mo} ${dd}`;

    const size = Math.round(w * 0.038);
    const padX = Math.round(w * 0.045);
    const padY = Math.round(h * 0.05);

    ctx.save();
    ctx.font = `italic 700 ${size}px "Fraunces", "Iowan Old Style", Georgia, serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";

    // soft outer halo
    ctx.shadowColor = "rgba(255, 90, 30, 0.85)";
    ctx.shadowBlur = Math.round(w * 0.022);
    ctx.fillStyle = "rgba(255, 130, 50, 0.95)";
    ctx.fillText(text, w - padX, h - padY);

    // crisp inner pass for legibility
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255, 200, 130, 0.95)";
    ctx.fillText(text, w - padX, h - padY);
    ctx.restore();
  }

  /* ---------- finish roll & develop ---------- */

  async function finishRoll() {
    if (!state.roll) return;
    stopStream();
    showScreen("developing");

    // animated progress that doubles as actual rendering time
    const photos = state.roll.photos.slice();
    const rollSize = state.roll.rollSize;

    const subs = [
      "do not open the darkroom door",
      "agitating chemistry…",
      "rinsing in stop bath…",
      "fixing the silver…",
      "drying under the safelight…",
    ];
    let subIdx = 0;
    const subTimer = setInterval(() => {
      subIdx = (subIdx + 1) % subs.length;
      els.developingSub.textContent = subs[subIdx];
    }, 1100);

    const setBar = (p) => {
      els.developingBar.style.width = `${Math.round(p * 100)}%`;
    };

    setBar(0.05);
    await wait(400);
    setBar(0.2);
    await wait(500);

    // load all images in parallel
    setBar(0.35);
    const imgs = await Promise.all(photos.map(loadImage));
    setBar(0.6);
    await wait(400);

    // build the strip
    const { canvas, blob } = await composeStrip(imgs, rollSize);
    setBar(0.9);
    await wait(500);

    // copy to display canvas
    const dst = els.stripCanvas;
    dst.width = canvas.width;
    dst.height = canvas.height;
    dst.getContext("2d").drawImage(canvas, 0, 0);

    state.stripBlob = blob;
    state.stripFilename = makeFilename();

    setBar(1);
    await wait(500);
    clearInterval(subTimer);

    showScreen("strip");

    // configure share button if supported
    if (navigator.canShare && blob) {
      const file = new File([blob], state.stripFilename, { type: "image/jpeg" });
      if (navigator.canShare({ files: [file] })) {
        els.shareBtn.hidden = false;
      }
    }

    // clear persisted roll — user has the artifact now
    clearStoredRoll();
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  /* ---------- strip composition ---------- */

  async function composeStrip(images, rollSize) {
    const n = images.length;
    const slotH = STRIP.photoSize + STRIP.gap;
    const photosBlockH = n * STRIP.photoSize + (n - 1) * STRIP.gap;
    const totalH = STRIP.headerH + photosBlockH + STRIP.footerH;

    const canvas = document.createElement("canvas");
    canvas.width = STRIP.width;
    canvas.height = totalH;
    const ctx = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });

    // paper background with subtle gradient (warm aged cream)
    const bgGrad = ctx.createLinearGradient(0, 0, 0, totalH);
    bgGrad.addColorStop(0,    "#f8ebc7");
    bgGrad.addColorStop(0.5,  STRIP.paper);
    bgGrad.addColorStop(1,    "#f0dfb1");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, STRIP.width, totalH);

    // paper grain
    addPaperNoise(ctx, STRIP.width, totalH);

    // perforations (subtle round holes top + bottom)
    drawPerforations(ctx, STRIP.width, totalH);

    // header
    drawHeader(ctx);

    // photos
    for (let i = 0; i < n; i++) {
      const y = STRIP.headerH + i * slotH;
      drawPhotoSlot(ctx, images[i], STRIP.sidePad, y, STRIP.photoSize);
    }

    // footer
    drawFooter(ctx, totalH, n, rollSize);

    const blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92)
    );

    return { canvas, blob };
  }

  function addPaperNoise(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 8;
      d[i] = clamp(d[i] + n);
      d[i + 1] = clamp(d[i + 1] + n);
      d[i + 2] = clamp(d[i + 2] + n);
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawPerforations(ctx, w, h) {
    ctx.save();
    ctx.fillStyle = "rgba(42, 18, 12, 0.10)";
    const r = 4;
    const spacing = 22;
    for (let x = spacing / 2; x < w; x += spacing) {
      ctx.beginPath();
      ctx.arc(x, 18, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, h - 18, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHeader(ctx) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = STRIP.ink;

    ctx.font =
      "italic 400 60px 'Fraunces', 'Iowan Old Style', Georgia, serif";
    ctx.fillText("disposaphone", STRIP.width / 2, 84);

    // accent underline
    ctx.fillStyle = STRIP.accent;
    ctx.fillRect(STRIP.width / 2 - 40, 100, 80, 2);

    // date
    ctx.fillStyle = "#6e5230";
    ctx.font = "600 13px 'Fraunces', 'Iowan Old Style', Georgia, serif";
    ctx.fillText(
      formatDate(new Date()).toUpperCase().split("").join(" "),
      STRIP.width / 2,
      126
    );

    ctx.restore();
  }

  function drawFooter(ctx, totalH, n, rollSize) {
    ctx.save();
    const y = totalH - STRIP.footerH;
    ctx.textAlign = "center";

    ctx.fillStyle = "#6e5230";
    ctx.font = "600 13px 'Fraunces', 'Iowan Old Style', Georgia, serif";
    ctx.fillText(
      `${String(n).padStart(2, "0")}  /  ${String(rollSize).padStart(2, "0")}   E X P O S U R E S`,
      STRIP.width / 2,
      y + 36
    );

    ctx.fillStyle = STRIP.accent;
    ctx.fillRect(STRIP.width / 2 - 26, y + 50, 52, 1.5);

    ctx.fillStyle = "#8a6e44";
    ctx.font = "italic 500 13px 'Fraunces', 'Iowan Old Style', Georgia, serif";
    ctx.fillText(
      "developed at home  ·  one of one",
      STRIP.width / 2,
      y + 76
    );
    ctx.restore();
  }

  function drawPhotoSlot(ctx, img, x, y, size) {
    // soft drop shadow
    ctx.save();
    ctx.shadowColor = "rgba(31, 22, 16, 0.18)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;

    // white photo border
    const b = STRIP.photoBorder;
    ctx.fillStyle = "#fffaf0";
    roundRect(ctx, x - b, y - b, size + b * 2, size + b * 2, 3);
    ctx.fill();
    ctx.restore();

    // image
    ctx.drawImage(img, x, y, size, size);

    // tiny inner shadow line for depth
    ctx.save();
    ctx.strokeStyle = "rgba(31, 22, 16, 0.12)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function formatDate(d) {
    const months = [
      "jan","feb","mar","apr","may","jun",
      "jul","aug","sep","oct","nov","dec",
    ];
    const day = String(d.getDate()).padStart(2, "0");
    const m = months[d.getMonth()];
    const y = d.getFullYear();
    return `${day} ${m} ${y}`;
  }

  function makeFilename() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `disposaphone-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.jpg`;
  }

  /* ---------- strip actions ---------- */

  function bindStripActions() {
    els.downloadBtn.addEventListener("click", () => {
      if (!state.stripBlob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(state.stripBlob);
      a.download = state.stripFilename || "disposaphone.jpg";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });

    els.shareBtn.addEventListener("click", async () => {
      if (!state.stripBlob || !navigator.canShare) return;
      const file = new File(
        [state.stripBlob],
        state.stripFilename || "disposaphone.jpg",
        { type: "image/jpeg" }
      );
      try {
        await navigator.share({
          files: [file],
          title: "Disposaphone",
          text: "fresh from the darkroom",
        });
      } catch {
        // user cancelled — ignore
      }
    });

    els.newRollBtn.addEventListener("click", () => {
      state.roll = null;
      state.stripBlob = null;
      state.stripFilename = "";
      clearStoredRoll();
      setRollIdx(ROLL_DEFAULT_IDX, { animate: false });
      els.resumeNotice.hidden = true;
      els.shareBtn.hidden = true;
      showScreen("intro");
    });
  }

  /* ---------- visibility / cleanup ---------- */

  document.addEventListener("visibilitychange", () => {
    // pause stream when tab hidden (saves battery, prevents overheating)
    if (document.hidden) {
      stopStream();
    } else if (screens.camera.classList.contains("is-active")) {
      startStream();
    }
  });

  window.addEventListener("beforeunload", () => {
    stopStream();
  });

  /* ---------- boot ---------- */

  function boot() {
    initIntro();
    bindCameraControls();
    bindStripActions();
    showScreen("intro");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
