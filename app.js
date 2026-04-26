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

  // working resolution per photo. balance: bigger = sharper but slower
  // filter passes & larger localStorage footprint (24 photos × ~140KB ≈ 3.4MB)
  const PHOTO_SIZE = 960;
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
    cameraHint: $("#cameraHint"),

    developingSub: $("#developingSub"),
    developingBar: document.querySelector(".developing__bar"),

    stripCanvas: $("#stripCanvas"),
    photosGrid: $("#photosGrid"),
    devStylePicker: document.querySelector(".dev-style-picker"),
    downloadBtn: $("#downloadBtn"),
    downloadBtnLabel: $("#downloadBtnLabel"),
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
    /** developed images cached so we can recompose styles without reloading */
    /** @type {HTMLImageElement[]} */
    developed: [],
    /** @type {"strip"|"collage"|"photos"} */
    devStyle: "strip",
    /** rollSize captured at finishRoll for footer text on collage */
    devRollSize: 0,
  };

  // request-id for startStream() so a stale getUserMedia resolution
  // can't clobber a newer one (real concern on iOS where the permission
  // prompt fires visibilitychange and we get racy re-entries)
  let streamRequestId = 0;
  // visibility hide timer — gives a 2s grace period before tearing the
  // stream down so brief prompt overlays don't kill it
  let visibilityHideTimer = null;
  // silent retry timer for transient stream failures
  let streamRetryTimer = null;
  // count of capture frames currently being processed in the background
  let inFlightCount = 0;
  // sequential queue so concurrent shots stay in order in the roll
  let processingQueue = Promise.resolve();

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
    // already have a healthy stream? unhide UI and bail — avoids the
    // double-start that happens when iOS fires visibilitychange while
    // showing the permission prompt
    if (
      state.stream &&
      state.stream.getVideoTracks().some((t) => t.readyState === "live")
    ) {
      showCameraLoading(false);
      els.shutterBtn.disabled = false;
      return;
    }

    cancelStreamRetry();
    const myId = ++streamRequestId;
    stopStream();
    showCameraLoading(true);

    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn("[disposaphone] getUserMedia is not available");
      return;
    }

    const facing = state.roll?.facingMode ?? "environment";

    /** @type {MediaStreamConstraints} */
    const constraints = {
      audio: false,
      video: { facingMode: { ideal: facing } },
    };

    /** @type {MediaStream} */
    let stream;
    try {
      stream = await getUserMediaResilient(constraints);
    } catch (err) {
      // a newer call superseded us — keep quiet
      if (myId !== streamRequestId) return;
      handleStreamError(err);
      return;
    }

    // a newer call took over while we were awaiting — drop this stream
    if (myId !== streamRequestId) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

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
      // autoplay can be cranky; we have a user gesture (the shutter) later
    }

    if (myId !== streamRequestId) return; // bail if superseded
    showCameraLoading(false);
    els.shutterBtn.disabled = false;
  }

  // wrap getUserMedia with a one-shot retry on transient errors and a
  // relaxed-constraint fallback if facingMode can't be honored
  async function getUserMediaResilient(constraints) {
    const transient = /NotFound|NotReadable|TrackStart|Aborted/i;
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // transient — wait a beat and try once more
      if (err && transient.test(err.name || "")) {
        await wait(500);
        try {
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err2) {
          err = err2;
        }
      }
      // facingMode unmet? drop it entirely and ask for any camera
      if (
        err &&
        /Overconstrained|NotFound/i.test(err.name || "") &&
        constraints.video &&
        typeof constraints.video === "object" &&
        constraints.video.facingMode
      ) {
        return await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: true,
        });
      }
      throw err;
    }
  }

  function handleStreamError(err) {
    // never show a visible warning. log for devs, and silently retry
    // on transient failures so the camera tends to "just come up" once
    // permission is granted / the camera is free.
    console.warn("[disposaphone] camera init issue:", err);
    const name = (err && err.name) || "";
    // permission denied is a hard stop until the user changes browser
    // settings — no point retrying, the call would just keep failing
    if (/NotAllowed|Permission/i.test(name)) return;
    scheduleStreamRetry();
  }

  function scheduleStreamRetry() {
    if (streamRetryTimer) clearTimeout(streamRetryTimer);
    streamRetryTimer = setTimeout(() => {
      streamRetryTimer = null;
      if (
        screens.camera.classList.contains("is-active") &&
        !state.stream &&
        !document.hidden
      ) {
        startStream();
      }
    }, 2500);
  }

  function cancelStreamRetry() {
    if (streamRetryTimer) {
      clearTimeout(streamRetryTimer);
      streamRetryTimer = null;
    }
  }

  function stopStream() {
    cancelStreamRetry();
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    els.video.srcObject = null;
  }

  function showCameraLoading(loading) {
    els.cameraLoading.classList.toggle("is-hidden", !loading);
  }

  function bindCameraControls() {
    els.shutterBtn.addEventListener("click", onShutter);
    els.flipBtn.addEventListener("click", async () => {
      if (!state.roll) return;
      state.roll.facingMode =
        state.roll.facingMode === "environment" ? "user" : "environment";
      saveRoll();
      // explicitly tear down so startStream doesn't short-circuit
      // on the "already healthy" guard
      stopStream();
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
  }

  /* ---------- shutter ---------- */

  function updateCounter() {
    if (!state.roll) {
      els.counter.textContent = "--";
      return;
    }
    // count completed + in-flight so the counter reflects what the
    // user has fired even before the filter finishes processing
    const used = state.roll.photos.length + inFlightCount;
    const left = Math.max(0, state.roll.rollSize - used);
    els.counter.textContent = String(left).padStart(2, "0");
  }

  function rollIsFull() {
    return (
      !!state.roll &&
      state.roll.photos.length + inFlightCount >= state.roll.rollSize
    );
  }

  async function onShutter() {
    if (state.capturing || !state.roll) return;
    if (rollIsFull()) return;
    if (!state.stream) return;

    state.capturing = true;

    // grab the raw frame synchronously — this is fast (~5-15ms even on
    // slow phones) so the visual feedback fires immediately
    const frame = grabRawFrame();
    if (!frame) {
      // video isn't ready yet; abort silently, no flash, no click
      state.capturing = false;
      return;
    }

    // instant feedback now that we have the frame
    flashEffect();
    shutterPulse();
    shutterClick();
    vibrate(30);

    inFlightCount++;
    updateCounter();
    els.shutterBtn.disabled = true;

    // re-enable the shutter quickly (not waiting for filter to finish)
    // so the user can keep firing — disposable-camera vibes
    setTimeout(() => {
      state.capturing = false;
      if (!rollIsFull()) {
        els.shutterBtn.disabled = false;
      }
    }, 220);

    // queue the heavy filter work sequentially so photos stay in order
    const slotIdx = state.roll.photos.length + inFlightCount - 1;
    const myTurn = processingQueue.then(() => processFrame(frame, slotIdx));
    processingQueue = myTurn.catch(() => {}); // keep the queue alive on errors

    myTurn.then(
      (dataUrl) => {
        inFlightCount--;
        if (!state.roll) return;
        state.roll.photos.push(dataUrl);
        saveRoll();
        updateCounter();
        if (state.roll.photos.length >= state.roll.rollSize) {
          finishRoll();
        } else if (!state.capturing) {
          els.shutterBtn.disabled = false;
        }
      },
      (err) => {
        inFlightCount--;
        console.error("[disposaphone] capture failed:", err);
        updateCounter();
        if (!rollIsFull() && !state.capturing) {
          els.shutterBtn.disabled = false;
        }
      }
    );
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

  // fast: grab a center-cropped square frame from the video to a canvas.
  // this runs synchronously on tap so the user gets immediate feedback;
  // the heavy filter work happens in processFrame() afterwards.
  function grabRawFrame() {
    const video = els.video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

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
    if (!ctx) return null;

    if (state.roll?.facingMode === "user") {
      ctx.translate(PHOTO_SIZE, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  // slow: apply the full vintage filter and encode as JPEG.
  // chunked between rAF yields so the UI stays responsive on phones.
  async function processFrame(canvas, slotIdx) {
    const ctx = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!ctx) throw new Error("2d context unavailable");
    const w = canvas.width;
    const h = canvas.height;

    await rafYield();
    applyVintageGrade(ctx, w, h);
    await rafYield();
    applyHalation(ctx, w, h);
    applyLightLeak(ctx, w, h, cornerForSlot(slotIdx));
    applyVignette(ctx, w, h, 0.55);
    await rafYield();
    applyGrain(ctx, w, h, 16);
    drawDateStamp(ctx, w, h, new Date());
    await rafYield();

    return canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
  }

  function rafYield() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function cornerForSlot(idx) {
    return ["top-right", "bottom-left", "top-left", "bottom-right"][idx % 4];
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
  // optimized: do the mask + blur on a 1/4-scale canvas (16x fewer pixels),
  // then upscale on composite. visually nearly identical, much faster.
  function applyHalation(ctx, w, h) {
    const SMALL = Math.max(120, Math.round(w / 4));

    const tmp = document.createElement("canvas");
    tmp.width = SMALL;
    tmp.height = SMALL;
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.drawImage(ctx.canvas, 0, 0, SMALL, SMALL);

    const id = tctx.getImageData(0, 0, SMALL, SMALL);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const t = Math.max(0, lum - 170) / 85; // 170-255 -> 0-1
      const mask = Math.min(1, t * t);
      d[i]     = 255;
      d[i + 1] = 130 + 40 * mask;
      d[i + 2] = 60  + 20 * mask;
      d[i + 3] = Math.round(mask * 200);
    }
    tctx.putImageData(id, 0, 0);

    const blurred = document.createElement("canvas");
    blurred.width = SMALL;
    blurred.height = SMALL;
    const bctx = blurred.getContext("2d");
    if ("filter" in bctx) {
      bctx.filter = `blur(${Math.max(2, Math.round(SMALL * 0.04))}px)`;
      bctx.drawImage(tmp, 0, 0);
    } else {
      // fallback: the 1/4 downscale already smooths things; upscale will blur further
      bctx.drawImage(tmp, 0, 0);
    }

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.55;
    ctx.drawImage(blurred, 0, 0, SMALL, SMALL, 0, 0, w, h);
    ctx.restore();
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
    // guard against double-entry (auto-develop + manual button)
    if (screens.developing.classList.contains("is-active")) return;
    stopStream();
    showScreen("developing");

    // wait for any in-flight filter processing to land in the roll
    // (sequential queue, so this resolves once the last shot is encoded)
    await processingQueue.catch(() => {});

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

    // load all images in parallel — cache them so style switches don't
    // re-decode the JPEG dataURLs every time
    setBar(0.35);
    state.developed = await Promise.all(photos.map(loadImage));
    state.devRollSize = rollSize;
    setBar(0.6);
    await wait(400);

    // default style: strip
    state.devStyle = "strip";
    setActiveStylePill("strip");
    await renderDevelopStyle("strip");
    setBar(0.9);
    await wait(500);

    setBar(1);
    await wait(500);
    clearInterval(subTimer);

    showScreen("strip");

    // clear persisted roll — user has the artifact(s) now
    clearStoredRoll();
  }

  /* ---------- develop styles ---------- */

  async function renderDevelopStyle(style) {
    state.devStyle = style;
    const imgs = state.developed;
    const rollSize = state.devRollSize;
    if (!imgs || imgs.length === 0) return;

    // reset state
    els.shareBtn.hidden = true;
    state.stripBlob = null;
    state.stripFilename = "";

    if (style === "photos") {
      // hide canvas, render the grid
      els.stripCanvas.style.display = "none";
      els.photosGrid.hidden = false;
      renderPhotosGrid(imgs);
      els.downloadBtnLabel.textContent =
        imgs.length === 1 ? "save the photo" : "save all photos";
      return;
    }

    // canvas-based styles
    els.photosGrid.hidden = true;
    els.stripCanvas.style.display = "";

    // update label + canvas sizing BEFORE the await so the UI feels
    // snappy when switching tabs (compose can take ~500ms)
    let canvas, blob, filenameSuffix;
    if (style === "collage") {
      filenameSuffix = "collage";
      els.stripCanvas.classList.add("is-wide");
      els.downloadBtnLabel.textContent = "save the collage";
      ({ canvas, blob } = await composeCollage(imgs, rollSize));
    } else {
      filenameSuffix = "strip";
      els.stripCanvas.classList.remove("is-wide");
      els.downloadBtnLabel.textContent = "save the strip";
      ({ canvas, blob } = await composeStrip(imgs, rollSize));
    }

    // copy to display canvas
    const dst = els.stripCanvas;
    dst.width = canvas.width;
    dst.height = canvas.height;
    dst.getContext("2d").drawImage(canvas, 0, 0);
    // restart the drop animation
    dst.style.animation = "none";
    void dst.offsetWidth;
    dst.style.animation = "";

    state.stripBlob = blob;
    state.stripFilename = makeFilename(filenameSuffix);

    if (navigator.canShare && blob) {
      const file = new File([blob], state.stripFilename, {
        type: "image/jpeg",
      });
      if (navigator.canShare({ files: [file] })) {
        els.shareBtn.hidden = false;
      }
    }
  }

  function setActiveStylePill(style) {
    els.devStylePicker.querySelectorAll(".dev-style-pill").forEach((p) => {
      const active = p.dataset.style === style;
      p.classList.toggle("is-active", active);
      p.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function renderPhotosGrid(imgs) {
    els.photosGrid.innerHTML = "";
    imgs.forEach((img, i) => {
      const btn = document.createElement("button");
      btn.className = "photos-grid__item";
      btn.type = "button";
      btn.setAttribute("aria-label", `save photo ${i + 1}`);
      const tag = document.createElement("img");
      tag.src = img.src;
      tag.alt = `photo ${i + 1}`;
      tag.draggable = false;
      btn.appendChild(tag);
      btn.addEventListener("click", () => downloadOnePhoto(img, i));
      els.photosGrid.appendChild(btn);
    });
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

  /* ---------- collage composition ---------- */

  // pick (cols, rows) for n photos — landscape-leaning so collages
  // feel distinct from the vertical photobooth strip
  function collageGrid(n) {
    if (n <= 1) return { cols: 1, rows: 1 };
    if (n <= 2) return { cols: 2, rows: 1 };
    if (n <= 4) return { cols: 2, rows: 2 };
    if (n <= 6) return { cols: 3, rows: 2 };
    if (n <= 8) return { cols: 4, rows: 2 };
    if (n <= 12) return { cols: 4, rows: 3 };
    if (n <= 16) return { cols: 4, rows: 4 };
    if (n <= 20) return { cols: 5, rows: 4 };
    return { cols: 6, rows: 4 }; // 24
  }

  // tiny deterministic prng so a given roll always tilts the same way
  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  async function composeCollage(images, rollSize) {
    const n = images.length;
    const { cols, rows } = collageGrid(n);

    const PHOTO = 360;
    const GAP = 26;
    const HPAD = 44;
    const HEADER = 130;
    const FOOTER = 96;

    const innerW = cols * PHOTO + (cols - 1) * GAP;
    const innerH = rows * PHOTO + (rows - 1) * GAP;
    const totalW = innerW + 2 * HPAD;
    const totalH = innerH + HEADER + FOOTER;

    const canvas = document.createElement("canvas");
    canvas.width = totalW;
    canvas.height = totalH;
    const ctx = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });

    // paper bg with the same warm gradient as the strip
    const bgGrad = ctx.createLinearGradient(0, 0, 0, totalH);
    bgGrad.addColorStop(0, "#f8ebc7");
    bgGrad.addColorStop(0.5, STRIP.paper);
    bgGrad.addColorStop(1, "#f0dfb1");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, totalW, totalH);
    addPaperNoise(ctx, totalW, totalH);

    // header (centered)
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = STRIP.ink;
    ctx.font =
      "italic 400 60px 'Fraunces', 'Iowan Old Style', Georgia, serif";
    ctx.fillText("disposaphone", totalW / 2, 78);
    ctx.fillStyle = STRIP.accent;
    ctx.fillRect(totalW / 2 - 40, 94, 80, 2);
    ctx.fillStyle = "#6e5230";
    ctx.font = "600 13px 'Fraunces', 'Iowan Old Style', Georgia, serif";
    ctx.fillText(
      formatDate(new Date()).toUpperCase().split("").join(" "),
      totalW / 2,
      118
    );
    ctx.restore();

    // photos: each tilted slightly with a soft drop shadow
    const rand = mulberry32(0x1d05a + n);
    const startX = HPAD;
    const startY = HEADER;
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx = startX + c * (PHOTO + GAP) + PHOTO / 2;
      const cy = startY + r * (PHOTO + GAP) + PHOTO / 2;
      // -3.5° to +3.5° tilt — different per photo, but stable per roll
      const tilt = ((rand() - 0.5) * 7 * Math.PI) / 180;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tilt);
      // shadow under the white border
      ctx.shadowColor = "rgba(31, 22, 16, 0.22)";
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 6;

      const b = STRIP.photoBorder; // white border around each photo
      ctx.fillStyle = "#fffaf0";
      const half = PHOTO / 2;
      ctx.fillRect(-half - b, -half - b, PHOTO + b * 2, PHOTO + b * 2);

      // image (no shadow on the bitmap itself)
      ctx.shadowColor = "transparent";
      ctx.drawImage(images[i], -half, -half, PHOTO, PHOTO);

      // subtle inner edge
      ctx.strokeStyle = "rgba(31, 22, 16, 0.10)";
      ctx.lineWidth = 1;
      ctx.strokeRect(-half + 0.5, -half + 0.5, PHOTO - 1, PHOTO - 1);

      ctx.restore();
    }

    // footer
    ctx.save();
    ctx.textAlign = "center";
    const fy = totalH - FOOTER;
    ctx.fillStyle = "#6e5230";
    ctx.font = "600 13px 'Fraunces', 'Iowan Old Style', Georgia, serif";
    ctx.fillText(
      `${String(n).padStart(2, "0")}  /  ${String(rollSize).padStart(2, "0")}   E X P O S U R E S`,
      totalW / 2,
      fy + 36
    );
    ctx.fillStyle = STRIP.accent;
    ctx.fillRect(totalW / 2 - 26, fy + 50, 52, 1.5);
    ctx.fillStyle = "#8a6e44";
    ctx.font =
      "italic 500 13px 'Fraunces', 'Iowan Old Style', Georgia, serif";
    ctx.fillText(
      "developed at home  ·  one of one",
      totalW / 2,
      fy + 76
    );
    ctx.restore();

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

  function makeFilename(suffix) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const tag = suffix ? `-${suffix}` : "";
    return `disposaphone-${stamp}${tag}.jpg`;
  }

  /* ---------- strip / result actions ---------- */

  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename || "disposaphone.jpg";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function downloadOnePhoto(img, idx) {
    const blob = await imageToBlob(img);
    if (!blob) return;
    const stamp = makeFilename(`photo-${String(idx + 1).padStart(2, "0")}`);
    downloadBlob(blob, stamp);
  }

  // turn an HTMLImageElement (loaded from a JPEG dataURL) back into a Blob
  async function imageToBlob(img) {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d", { alpha: false });
    cx.drawImage(img, 0, 0);
    return new Promise((resolve) =>
      c.toBlob((b) => resolve(b), "image/jpeg", 0.92)
    );
  }

  async function downloadAllPhotos() {
    const imgs = state.developed;
    if (!imgs || imgs.length === 0) return;
    // sequential with a small gap so browsers don't dedupe / drop calls
    for (let i = 0; i < imgs.length; i++) {
      await downloadOnePhoto(imgs[i], i);
      await wait(220);
    }
  }

  function bindStripActions() {
    els.downloadBtn.addEventListener("click", async () => {
      if (state.devStyle === "photos") {
        await downloadAllPhotos();
        return;
      }
      if (!state.stripBlob) return;
      downloadBlob(state.stripBlob, state.stripFilename);
    });

    els.shareBtn.addEventListener("click", async () => {
      if (state.devStyle === "photos") return; // share doesn't apply
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

    // style picker
    els.devStylePicker.addEventListener("click", (e) => {
      const btn = e.target.closest(".dev-style-pill");
      if (!btn) return;
      const style = btn.dataset.style;
      if (!style || style === state.devStyle) return;
      setActiveStylePill(style);
      renderDevelopStyle(style);
    });

    els.newRollBtn.addEventListener("click", () => {
      state.roll = null;
      state.stripBlob = null;
      state.stripFilename = "";
      state.developed = [];
      state.devRollSize = 0;
      state.devStyle = "strip";
      inFlightCount = 0;
      processingQueue = Promise.resolve();
      clearStoredRoll();
      setRollIdx(ROLL_DEFAULT_IDX, { animate: false });
      els.resumeNotice.hidden = true;
      els.shareBtn.hidden = true;
      els.photosGrid.hidden = true;
      els.photosGrid.innerHTML = "";
      els.stripCanvas.style.display = "";
      els.stripCanvas.classList.remove("is-wide");
      setActiveStylePill("strip");
      els.downloadBtnLabel.textContent = "save the strip";
      showScreen("intro");
    });
  }

  /* ---------- visibility / cleanup ---------- */

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // 2-second grace period — tolerates brief overlays like the
      // permission prompt without tearing the stream down
      visibilityHideTimer = setTimeout(() => {
        stopStream();
      }, 2000);
    } else {
      if (visibilityHideTimer) {
        clearTimeout(visibilityHideTimer);
        visibilityHideTimer = null;
      }
      if (
        screens.camera.classList.contains("is-active") &&
        !state.stream
      ) {
        startStream();
      }
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
