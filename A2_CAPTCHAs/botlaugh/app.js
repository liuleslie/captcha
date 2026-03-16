'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   laughCAPTCHA — app.js
   ────────────────────────────────────────────────────────────────────────────
   ARCHITECTURE OVERVIEW
   ─────────────────────
   The app is a tiny state machine (see S + setState).  All user-visible
   behaviour is driven by state transitions; buttons are enabled/disabled
   declaratively inside setState() rather than scattered across handlers.

   DATA PIPELINE (for one round):
     1. loadTargetAudio()  → fetch MP3 → decode to AudioBuffer (targetBuf)
     2. User presses hold  → MediaRecorder → Blob chunks → AudioBuffer (userBuf)
     3. extractFeatures()  → MFCCs (Meyda) + pitch (ACF) for both buffers
     4. dtw()              → normalised alignment cost
     5. runAnalysis()      → weighted score → setState(RESULT)

   TUNABLE CONSTANTS (top of file) — change these without touching logic.
   ════════════════════════════════════════════════════════════════════════════ */


/* ── Config ──────────────────────────────────────────────────────────────── */

// FRAME_SIZE: how many audio samples Meyda sees at once.
//   Must be a power of 2 (FFT requirement).
//   Larger → better frequency resolution but worse time resolution.
//   2048 @ 44100 Hz ≈ 46 ms per frame — good for voiced speech/laughter.
const FRAME_SIZE   = 2048;

// HOP_SIZE: how far we step between frames (overlap = FRAME_SIZE - HOP_SIZE).
//   512 means ~75% overlap — smooths features over time.
const HOP_SIZE     = 512;

// NUM_MFCC: number of cepstral coefficients to keep.
//   13 is the classic ASR setting.  C0 encodes overall energy;
//   C1–C12 encode the "shape" of the spectral envelope.
const NUM_MFCC     = 13;

// MAX_RECORD_S: hard safety ceiling — prevents runaway recordings if targetBuf
//   is not loaded.  Normal operation uses targetBuf.duration as the limit.
const MAX_RECORD_S = 8;

// PASS_SCORE: minimum weighted similarity (0–100) required to pass.
//   Raise this to make the CAPTCHA harder; lower it to make it more lenient.
//   Calibrated from real human attempts: best efforts score ~50–53%,
//   median efforts ~45–49%.  Set to 50 so a genuinely good attempt passes.
const PASS_SCORE   = 50;

// DTW_REF_DIST: the normalised DTW distance at which mScore ≈ 37%.
//   Formula: mScore = 100 * exp(-dist / DTW_REF_DIST).
//   ↑ means the exponential decays more slowly → easier scoring.
//   ↓ means any mismatch drops the score fast → harder scoring.
//
//   CALIBRATION (from real testing, 18 attempts on the same target):
//     Observed DTW distances: 26–51, clustering at 30–37.
//     With DTW_REF_DIST=12 (original): mScore collapsed to 1–12% for all attempts.
//     Solving for DTW_REF_DIST such that best attempt (dist≈26) → mScore≈50%:
//       50 = 100*exp(−26/DTW_REF_DIST)  →  DTW_REF_DIST = 26/ln(2) ≈ 37.5
//     Rounded to 38 to leave a small margin above the minimum observed distance.
const DTW_REF_DIST = 38;

// The 12 target laugh files.  pickTargetFile() draws from this randomly.
const TARGET_FILES = Array.from({ length: 12 }, (_, i) =>
  `4o-fem-laughs/test${i + 1}.mp3`
);


/* ── App state ───────────────────────────────────────────────────────────── */

// A frozen object used as an enum — Object.freeze() prevents accidental
// reassignment of the state names themselves.
const S = Object.freeze({
  INIT:      'init',       // before mic permission is granted
  IDLE:      'idle',       // audio loaded, waiting for user to press Play
  PLAYING:   'playing',   // target laugh is playing
  READY:     'ready',     // target finished — user can now record
  RECORDING: 'recording', // mic is live
  ANALYZING: 'analyzing', // feature extraction + DTW running
  RESULT:    'result',    // score shown; retry available
});

let appState    = S.INIT;
let solvedCount = 0;
let lastScore   = null;   // last computed score; null means no result yet this round

// AudioContext is the Web Audio API's engine.  It must be created inside a
// user gesture (click) because browsers block audio autoplay.
let audioCtx    = null;

// The MediaStream returned by getUserMedia — the raw mic feed.
let micStream   = null;

// Decoded PCM data stored as Web Audio AudioBuffers.
// getChannelData(0) returns a Float32Array of samples in [-1, 1].
let targetBuf   = null;   // target laugh
let userBuf     = null;   // user's recording

// MediaRecorder state
let recorder    = null;
let recChunks   = [];
let recTimer    = null;   // handle for the auto-stop setTimeout

// We keep the blob URL for the user's recording so we can replay it.
// URL.createObjectURL() returns a short-lived URL like blob:http://…/uuid.
let userBlobUrl = null;

// WaveSurfer instances — one per waveform panel.
// Both drive their own internal <audio> element for playback.
let wsTarget    = null;
let wsUser      = null;

// Live recording meter state
let recAnalyserNode = null;   // AnalyserNode tapped off the mic stream
let recRafId        = null;   // requestAnimationFrame handle
let recStartTime    = 0;      // Date.now() when recording began
let recRmsHistory   = [];     // accumulated RMS values — drawn as amplitude bars


/* ── DOM refs ────────────────────────────────────────────────────────────── */

const el  = id => document.getElementById(id);
const DOM = {
  announce:    el('announce'),
  announceErr: el('announce-err'),
  permScreen:  el('permission-screen'),
  permErr:     el('permission-error'),
  btnAllow:    el('btn-allow'),
  solvedCount: el('solved-count'),
  promptText:  el('prompt-text'),
  promptSub:   el('prompt-sub'),
  scoreWrap:   el('score-wrap'),
  scoreVal:    el('score-val'),
  scoreLabel:  el('score-label'),
  btnPlay:     el('btn-play'),
  btnHold:     el('btn-hold'),
  btnPlayUser: el('btn-play-user'),  // replay user's own recording
  btnPlayBoth: el('btn-play-both'),  // play target + user simultaneously
  btnRetry:    el('btn-retry'),
  aboutPanel:  el('about-panel'),
  btnTheme:    el('btn-theme'),
  btnAbout:    el('btn-about'),
  btnBack:     el('btn-back'),
};


/* ── Time formatter ──────────────────────────────────────────────────────── */

// Formats seconds → "m:ss" for the time/duration overlays.
const fmtTime = s => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s) % 60).padStart(2, '0')}`;
};


/* ── WaveSurfer gradient factory ─────────────────────────────────────────── */
/*
  Based on the WaveSurfer.js SoundCloud example.  A small off-screen canvas is
  created just to obtain a CanvasRenderingContext2D for building LinearGradient
  objects — WaveSurfer accepts these anywhere it accepts a CSS color string.

  The gradient mimics SoundCloud's "reflection" effect: the waveform bars have
  a bright top half and a slightly dimmer bottom half, separated by a thin
  white line at 70% of the height.  The progress (played) gradient is brighter
  than the wave (unplayed) gradient so the playhead's passage is visible.

  Returns { waveColor, progressColor } ready to pass to WaveSurfer.create().
*/
function makeGradients(topWave, botWave, topProg, botProg, height = 80) {
  const cv = document.createElement('canvas');
  cv.height = height;
  const c  = cv.getContext('2d');
  const H  = height;
  const H2 = H * 1.35;   // gradient extends slightly below the bar for the reflection

  const wave = c.createLinearGradient(0, 0, 0, H2);
  wave.addColorStop(0,                      topWave);
  wave.addColorStop((H * 0.7)     / H2,    topWave);
  wave.addColorStop((H * 0.7 + 1) / H2,    'rgba(255,255,255,0.25)');  // thin white line
  wave.addColorStop((H * 0.7 + 2) / H2,    'rgba(255,255,255,0.25)');
  wave.addColorStop((H * 0.7 + 3) / H2,    botWave);
  wave.addColorStop(1,                      botWave);

  const prog = c.createLinearGradient(0, 0, 0, H2);
  prog.addColorStop(0,                      topProg);
  prog.addColorStop((H * 0.7)     / H2,    topProg);
  prog.addColorStop((H * 0.7 + 1) / H2,    'rgba(255,255,255,0.6)');
  prog.addColorStop((H * 0.7 + 2) / H2,    'rgba(255,255,255,0.6)');
  prog.addColorStop((H * 0.7 + 3) / H2,    botProg);
  prog.addColorStop(1,                      botProg);

  return { waveColor: wave, progressColor: prog };
}

function waveGradients(dark) {
  return {
    target: dark
      ? makeGradients('#003d1a', '#001a0b', '#00e676', '#009e52')
      : makeGradients('#b8dfc7', '#d4eede', '#00963f', '#006628'),
    user: dark
      ? makeGradients('#3a1a00', '#1a0b00', '#ff8f00', '#c46800')
      : makeGradients('#f5ddb8', '#fcefd8', '#c46800', '#8f4c00'),
  };
}


/* ── WaveSurfer init ─────────────────────────────────────────────────────── */
/*
  Both wsTarget and wsUser now use:
    - Gradient waveColor/progressColor (SoundCloud-style vertical reflection)
    - interact: true  — click-to-seek + drag scrubbing for both
    - A cursor showing playback position
    - timeupdate / decode events → live time/duration overlays
    - addWaveOverlay() injects the hover highlight + time labels as DOM children

  wsTarget drives state transitions (finish → READY or restore RESULT).
  wsUser is fully independent — its playback never changes CAPTCHA state.
*/
function initWaveSurfers() {
  const dark   = document.documentElement.dataset.theme !== 'light';
  const cursor = dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)';
  const grads  = waveGradients(dark);

  wsTarget = WaveSurfer.create({
    container:     '#wf-target',
    waveColor:     grads.target.waveColor,
    progressColor: grads.target.progressColor,
    cursorWidth:   2,
    cursorColor:   cursor,
    height:        80,
    interact:      true,
    normalize:     true,
    barWidth:      2,
    barGap:        1,
  });

  // When the target laugh finishes playing:
  //   - If a score exists (user is reviewing), restore the result prompt.
  //   - If this was the first listen, advance to READY so they can record.
  wsTarget.on('finish', () => {
    if (lastScore !== null) setState(S.RESULT, lastScore);
    else setState(S.READY);
  });

  // Pause during recording/analyzing — scrubbing mid-recording is confusing.
  wsTarget.on('interaction', () => {
    if (appState === S.RECORDING || appState === S.ANALYZING) wsTarget.pause();
  });

  wsTarget.on('decode',     d => { el('dur-target').textContent  = fmtTime(d); });
  wsTarget.on('timeupdate', t => { el('time-target').textContent = fmtTime(t); });

  wsUser = WaveSurfer.create({
    container:     '#wf-user',
    waveColor:     grads.user.waveColor,
    progressColor: grads.user.progressColor,
    cursorWidth:   2,
    cursorColor:   cursor,
    height:        80,
    interact:      true,   // scrubbing enabled — clicking plays/pauses
    normalize:     true,
    barWidth:      2,
    barGap:        1,
  });

  // Clicking the user waveform toggles playback (SoundCloud-style interaction).
  wsUser.on('interaction', () => { if (userBuf) wsUser.playPause(); });

  wsUser.on('decode',     d => { el('dur-user').textContent  = fmtTime(d); });
  wsUser.on('timeupdate', t => { el('time-user').textContent = fmtTime(t); });

  // Inject SoundCloud-style hover highlight + time/duration labels into each waveform.
  addWaveOverlay('wf-target', 'time-target', 'dur-target');
  addWaveOverlay('wf-user',   'time-user',   'dur-user');
}

/*
  Appends three elements inside the WaveSurfer container div:
    .wf-hover — white overlay that slides right with pointer (see CSS)
    .wf-time  — current playback time (bottom-left)
    .wf-dur   — total duration (bottom-right)
  Wires pointermove → updates hover width.
  All elements are position:absolute via CSS; the container is position:relative.
*/
function addWaveOverlay(containerId, timeId, durId) {
  const wf = el(containerId);

  const hover = document.createElement('div');
  hover.className = 'wf-hover';
  hover.setAttribute('aria-hidden', 'true');
  wf.appendChild(hover);

  const timeSpan = document.createElement('span');
  timeSpan.id = timeId;
  timeSpan.className = 'wf-time';
  timeSpan.textContent = '0:00';
  wf.appendChild(timeSpan);

  const durSpan = document.createElement('span');
  durSpan.id = durId;
  durSpan.className = 'wf-dur';
  durSpan.textContent = '0:00';
  wf.appendChild(durSpan);

  wf.addEventListener('pointermove',  e => { hover.style.width = `${e.offsetX}px`; });
  wf.addEventListener('pointerleave', () => { hover.style.width = '0'; });
}


/* ── WAV encoder — converts AudioBuffer → Blob for WaveSurfer ────────────── */
/*
  WaveSurfer loads audio from a URL.  When we have a raw AudioBuffer
  (decoded PCM), we need to package it as a WAV Blob so we can create a
  blob: URL for WaveSurfer to load.

  WAV file layout (44-byte header + 16-bit PCM samples):
    Bytes 0–3   "RIFF"
    Bytes 4–7   file size − 8
    Bytes 8–11  "WAVE"
    Bytes 12–15 "fmt "
    Bytes 16–19 fmt chunk size = 16 (for PCM)
    Bytes 20–21 audio format = 1 (PCM, uncompressed)
    Bytes 22–23 channels = 1 (mono — we always take channel 0)
    Bytes 24–27 sample rate
    Bytes 28–31 byte rate = sampleRate × 2 (16-bit = 2 bytes/sample)
    Bytes 32–33 block align = 2
    Bytes 34–35 bits per sample = 16
    Bytes 36–39 "data"
    Bytes 40–43 data chunk size = numSamples × 2
    Bytes 44…   interleaved Int16 samples
*/
function audioBufToWavBlob(buf) {
  const ch  = buf.getChannelData(0);  // Float32Array, samples in [-1, 1]
  const sr  = buf.sampleRate;
  const len = ch.length;
  const ab  = new ArrayBuffer(44 + len * 2);
  const dv  = new DataView(ab);

  // Helper: write an ASCII string byte-by-byte into the DataView
  const str = (off, s) => [...s].forEach((c, i) => dv.setUint8(off + i, c.charCodeAt(0)));

  str(0, 'RIFF'); dv.setUint32(4,  36 + len * 2, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16,      true);
  dv.setUint16(20, 1,       true);
  dv.setUint16(22, 1,       true);
  dv.setUint32(24, sr,      true);
  dv.setUint32(28, sr * 2,  true);
  dv.setUint16(32, 2,       true);
  dv.setUint16(34, 16,      true);
  str(36, 'data'); dv.setUint32(40, len * 2, true);

  // Convert Float32 → Int16 (scale to 16-bit signed integer range)
  let off = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }

  return new Blob([ab], { type: 'audio/wav' });
}


/* ── Live recording meter ────────────────────────────────────────────────── */
/*
  While the user holds the button, we want the "you" wave-box to show a
  growing waveform rather than a blank box.

  Approach:
    1. Tap an AnalyserNode off the live mic MediaStream (read-only; does not
       affect what MediaRecorder captures).
    2. On every animation frame, read the time-domain data, compute the RMS
       amplitude, and push it into recRmsHistory[].
    3. Draw recRmsHistory as vertical amplitude bars filling left-to-right
       across the canvas, proportional to how much of MAX_RECORD_S has elapsed.
       This gives the user two pieces of information at once:
         - Horizontal fill = time elapsed / MAX_RECORD_S
         - Bar heights     = how loud their laugh is at each moment
    4. When recording stops, hide the canvas — WaveSurfer then loads the
       processed blob and draws the proper waveform on top.
*/

function startLiveMeter() {
  const canvas = document.getElementById('rec-canvas');
  const box    = canvas.parentElement;

  // Size the canvas to match the wave-box exactly (pixel-perfect, no blur)
  canvas.width  = box.offsetWidth  || 400;
  canvas.height = box.offsetHeight || 80;
  canvas.style.display = 'block';

  // AnalyserNode reads from the mic stream without consuming it —
  // MediaRecorder is still capturing the same stream independently.
  recAnalyserNode = audioCtx.createAnalyser();
  recAnalyserNode.fftSize = 512;
  recAnalyserNode.smoothingTimeConstant = 0.4;  // slight temporal smoothing
  const micSrc = audioCtx.createMediaStreamSource(micStream);
  micSrc.connect(recAnalyserNode);
  // Note: we do NOT connect recAnalyserNode to destination — mic stays silent

  const timeData   = new Float32Array(recAnalyserNode.frequencyBinCount);
  const meterMaxS  = targetBuf ? targetBuf.duration + 0.25 : MAX_RECORD_S;  // match auto-stop
  recRmsHistory    = [];
  recStartTime     = Date.now();

  const ctx2d = canvas.getContext('2d');
  const dark  = () => document.documentElement.dataset.theme !== 'light';

  // Fixed bar geometry — bars maintain constant width as recording progresses.
  // Previously: barSlotW = fillW / bars.length caused bars to stretch wider
  // as recRmsHistory grew past the NUM_BARS downsample threshold.
  // Fix: decide SLOT_W upfront; number of visible bars = floor(fillW / SLOT_W).
  const SLOT_W  = 3;   // px per bar (2px filled + 1px gap)
  const BAR_W   = 2;

  function draw() {
    recRafId = requestAnimationFrame(draw);
    recAnalyserNode.getFloatTimeDomainData(timeData);

    // RMS of the current frame — a simple per-frame energy measure
    let rms = 0;
    for (let i = 0; i < timeData.length; i++) rms += timeData[i] ** 2;
    rms = Math.sqrt(rms / timeData.length);
    recRmsHistory.push(Math.min(1, rms * 5));  // boost & clamp to [0, 1]

    const W        = canvas.width;
    const H        = canvas.height;
    const elapsed  = (Date.now() - recStartTime) / 1000;
    const progress = Math.min(1, elapsed / meterMaxS);

    // How many fixed-width slots fit in the current filled region?
    const maxSlots     = Math.floor(W / SLOT_W);          // total at 100%
    const visibleSlots = Math.round(progress * maxSlots);  // visible right now
    const fillW        = visibleSlots * SLOT_W;

    ctx2d.clearRect(0, 0, W, H);

    // Dim amber fill showing elapsed time proportion
    ctx2d.fillStyle = dark()
      ? 'rgba(255, 143, 0, 0.08)'
      : 'rgba(196, 104, 0, 0.08)';
    ctx2d.fillRect(0, 0, fillW, H);

    if (visibleSlots === 0 || recRmsHistory.length === 0) return;

    // Map history onto exactly visibleSlots bars — each bar has the same width.
    // Index into history proportionally so early bars don't get overwritten.
    const mid = H / 2;
    ctx2d.fillStyle = dark() ? '#ff8f00' : '#c46800';

    for (let i = 0; i < visibleSlots; i++) {
      const srcIdx = Math.min(
        Math.floor(i * recRmsHistory.length / visibleSlots),
        recRmsHistory.length - 1
      );
      const amp  = recRmsHistory[srcIdx];
      const barH = Math.max(2, amp * H * 0.88);
      ctx2d.fillRect(i * SLOT_W, mid - barH / 2, BAR_W, barH);
    }
  }

  draw();
}

function stopLiveMeter() {
  if (recRafId) { cancelAnimationFrame(recRafId); recRafId = null; }
  const canvas = document.getElementById('rec-canvas');
  if (canvas) canvas.style.display = 'none';
  // Disconnect the analyser so the mic stream is not held open unnecessarily
  if (recAnalyserNode) { recAnalyserNode.disconnect(); recAnalyserNode = null; }
}

/* ── Load target audio ───────────────────────────────────────────────────── */

function pickTargetFile() {
  return TARGET_FILES[Math.floor(Math.random() * TARGET_FILES.length)];
}

/*
  Fetch one of the target MP3s, decode it to an AudioBuffer, and hand the URL
  to WaveSurfer for the waveform display.

  fetch() → ArrayBuffer → AudioContext.decodeAudioData() → AudioBuffer.
  decodeAudioData() is async and handles MP3 decoding natively in the browser.
*/
async function loadTargetAudio(file) {
  const src = file || pickTargetFile();
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    targetBuf = await audioCtx.decodeAudioData(await res.arrayBuffer());
    wsTarget.load(src);                 // WaveSurfer draws the waveform
  } catch (err) {
    announce(`Could not load target laugh: ${err.message}`, true);
  }
}


/* ── Playback ────────────────────────────────────────────────────────────── */

/*
  Target laugh playback is now handled by WaveSurfer's internal <audio> element.
  wsTarget.play() starts from the current scrub position (not always 0),
  which is intentional — if the user scrubbed to a point and then clicks
  "play target", it continues from there.

  wsTarget.seekTo(0) resets to the beginning before playing on a fresh round.

  The 'finish' event on wsTarget (wired in initWaveSurfers) fires when audio
  ends and calls setState(S.READY), replacing the old src.onended callback.

  We still decode targetBuf separately via fetch → decodeAudioData for Meyda;
  WaveSurfer's internal audio element is not accessible for feature extraction.
*/
function playTarget() {
  if (!wsTarget) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  wsTarget.play();
}

/*
  Play back the user's laugh from the current scrub position.
  wsUser drives its own internal <audio> element — no BufferSource needed.
  Clicking btn-play-user OR clicking/scrubbing the wsUser waveform directly
  both route through here or through wsUser's own interaction handler.
  State does NOT change — this is a review listen, not a CAPTCHA step.
*/
function playUser() {
  if (!userBuf || !wsUser) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  wsUser.play();
}

/*
  Play target and user laughs simultaneously, both rewound to the start.
  Both are WaveSurfer instances with their own internal <audio> elements,
  triggered in the same JS turn — close enough to perceived sync for short clips.
  (Sample-level sync would require routing both through a Web Audio MediaElementSourceNode.)
*/
function playBoth() {
  if (!userBuf || !wsTarget || !wsUser) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  wsTarget.seekTo(0);
  wsUser.seekTo(0);
  wsTarget.play();
  wsUser.play();
}

/* ── Recording ───────────────────────────────────────────────────────────── */

/*
  MediaRecorder captures audio from micStream (the getUserMedia stream).
  We call recorder.start(100) — the 100 ms timeslice argument tells the
  browser to fire ondataavailable every 100 ms so we accumulate small chunks
  rather than getting one giant blob at the end.

  recChunks: Blob[]  → assembled into a single Blob in onRecStop.
*/
function startRec() {
  recChunks = [];
  recorder  = new MediaRecorder(micStream);
  recorder.ondataavailable = e => { if (e.data.size > 0) recChunks.push(e.data); };
  recorder.onstop = onRecStop;
  recorder.start(100);

  startLiveMeter();  // draw growing waveform on the user canvas while mic is live

  // Auto-stop when recording reaches target duration (+ 0.25 s grace).
  // Falls back to MAX_RECORD_S if targetBuf is somehow unavailable.
  const limitS = targetBuf ? targetBuf.duration + 0.25 : MAX_RECORD_S;
  recTimer = setTimeout(() => {
    if (appState === S.RECORDING) stopRec();
  }, limitS * 1000);
}

function stopRec() {
  clearTimeout(recTimer);
  stopLiveMeter();  // hide canvas before WaveSurfer loads the processed blob
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function onRecStop() {
  setState(S.ANALYZING);

  // Assemble all chunks into one Blob.  mimeType is whatever the browser
  // chose (typically audio/webm on Chrome, audio/ogg on Firefox).
  const blob    = new Blob(recChunks, { type: recorder.mimeType });

  // Create a blob: URL for WaveSurfer to load → draws user waveform
  userBlobUrl = URL.createObjectURL(blob);
  wsUser.load(userBlobUrl);

  try {
    // Decode the blob to a raw PCM AudioBuffer for Meyda analysis
    userBuf = await audioCtx.decodeAudioData(await blob.arrayBuffer());
    await runAnalysis();
  } catch {
    announce('Could not process your recording.', true);
    setState(S.READY);
  }
}


/* ── Feature extraction ──────────────────────────────────────────────────── */
/*
   We walk through the AudioBuffer in overlapping frames and extract two
   features per frame:

   MFCCs (Mel-Frequency Cepstral Coefficients)
   ────────────────────────────────────────────
   MFCCs are the standard compact representation of vocal timbre.  The
   pipeline inside Meyda is:
     1. Window the frame (Hann window)
     2. FFT → power spectrum
     3. Apply mel filterbank (perceptual frequency scale)
     4. Log of filterbank energies
     5. DCT → cepstral coefficients
   C0 ≈ overall energy; C1–C12 ≈ spectral shape (vowel quality, nasality, …).
   We get a 13-element vector per frame.  A sequence of these vectors over
   time forms a "fingerprint" of the laugh's spectral evolution.

   Pitch / F0 (via Autocorrelation)
   ─────────────────────────────────
   Autocorrelation measures how well a signal matches a time-shifted copy of
   itself.  For a periodic sound (voiced speech), there's a strong peak at the
   lag τ = 1/F0.  We search lags corresponding to 70–800 Hz (human voice range)
   and pick the strongest peak above an energy threshold.
   Unvoiced/silent frames return 0.

   FUTURE: extractFeatures() could also return spectralCentroid, chroma,
   or energy envelope — see sketch section.
*/
function extractFeatures(buf) {
  const ch      = buf.getChannelData(0);   // raw Float32Array of PCM samples
  const sr      = buf.sampleRate;
  const mfccs   = [];
  const pitches = [];

  // Configure Meyda once before iterating frames.
  // Meyda uses module-level globals rather than per-call options.
  Meyda.sampleRate             = sr;
  Meyda.bufferSize             = FRAME_SIZE;
  Meyda.numberOfMFCCComponents = NUM_MFCC;

  // Convert Hz bounds → lag bounds (lag = sampleRate / frequency)
  const minLag = Math.floor(sr / 800);   // 800 Hz upper pitch limit
  const maxLag = Math.floor(sr / 70);    //  70 Hz lower  pitch limit

  for (let i = 0; i + FRAME_SIZE <= ch.length; i += HOP_SIZE) {
    // subarray() is a zero-copy view — no data is copied here.
    // Meyda reads from this view without modifying it.
    const frame = ch.subarray(i, i + FRAME_SIZE);

    // ── MFCCs ──
    try {
      const feat = Meyda.extract(['mfcc'], frame);
      if (feat && Array.isArray(feat.mfcc) && feat.mfcc.length === NUM_MFCC) {
        // .slice() detaches from Meyda's internal reused buffer —
        // without this, every entry in mfccs[] would point to the same array.
        mfccs.push(feat.mfcc.slice());
      }
    } catch { /* Meyda can reject frames with all-zero content; skip them */ }

    // ── Pitch (ACF) ──
    pitches.push(acfPitch(frame, sr, minLag, maxLag));
  }

  return { mfccs, pitches };
}

/*
  Autocorrelation pitch estimator.
  ─────────────────────────────────
  For a frame f of length N, the autocorrelation at lag τ is:
      r(τ) = Σ f[i] * f[i + τ]   for i = 0 … N-τ-1
  We search τ in [minLag, maxLag] for the peak and convert to Hz: F0 = sr / τ.
  Confidence check: the peak must exceed 35% of the zero-lag energy (r(0))
  to be considered voiced.
*/
function acfPitch(frame, sr, minLag, maxLag) {
  // RMS energy of the frame — skip near-silent frames entirely
  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
  if (energy / frame.length < 1e-6) return 0;

  let best = -Infinity, bestLag = 0;
  const n  = frame.length;

  for (let lag = minLag; lag <= Math.min(maxLag, n - 1); lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += frame[i] * frame[i + lag];
    if (s > best) { best = s; bestLag = lag; }
  }

  // If peak correlation is strong enough, return F0; otherwise return 0 (unvoiced)
  return (bestLag > 0 && best > 0.35 * energy) ? sr / bestLag : 0;
}


/* ── Dynamic Time Warping ────────────────────────────────────────────────── */
/*
  DTW finds the optimal non-linear alignment between two time series.
  Unlike a direct frame-by-frame comparison, it can handle a laugh that is
  faster or slower than the target — it warps the time axis to minimise total
  distance.

  This implementation uses a rolling two-row buffer instead of the full N×M
  cost matrix, reducing memory from O(n*m) to O(m).  This is important when
  sequences are hundreds of frames long.

  The standard recurrence:
      cost[i][j] = dist(a[i], b[j]) + min(cost[i-1][j],    ← insert
                                          cost[i][j-1],    ← delete
                                          cost[i-1][j-1])  ← match

  We normalise by (n + m) so that longer sequences don't automatically produce
  larger raw distances — the result is a per-step average distance.

  FUTURE: add a Sakoe-Chiba band constraint (limit |i-j| < bandwidth) to
  prevent pathological warpings and speed up computation — see sketch section.
*/
function dtw(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return DTW_REF_DIST * 2;  // graceful failure → low score

  let prev = new Float32Array(m).fill(Infinity);
  let curr = new Float32Array(m).fill(Infinity);

  // Initialise first row (aligning a[0] with every b[j])
  prev[0] = euc13(a[0], b[0]);
  for (let j = 1; j < m; j++) prev[j] = prev[j - 1] + euc13(a[0], b[j]);

  for (let i = 1; i < n; i++) {
    curr[0] = prev[0] + euc13(a[i], b[0]);  // first column: align a[i] with b[0]
    for (let j = 1; j < m; j++) {
      curr[j] = euc13(a[i], b[j]) + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    // Swap rows — prev becomes the old curr; curr is cleared for the next row
    [prev, curr] = [curr, prev];
    curr.fill(Infinity);
  }

  return prev[m - 1] / (n + m);  // normalised cost
}

/*
  Euclidean distance between two 13-element MFCC vectors.
  Using || 0 guards against occasional NaN/undefined values from Meyda.
*/
function euc13(a, b) {
  let s = 0;
  for (let k = 0; k < NUM_MFCC; k++) {
    const d = (a[k] || 0) - (b[k] || 0);
    s += d * d;
  }
  return Math.sqrt(s);
}


/* ── Similarity scoring ──────────────────────────────────────────────────── */
/*
  Final score = 75% MFCC similarity + 25% pitch similarity.

  mScore — spectral shape match via DTW:
    Uses an exponential decay: score = 100 * e^(−dist / DTW_REF_DIST).
    At dist=0 (perfect) → 100.  At dist=DTW_REF_DIST → ~37.  At dist=∞ → 0.
    Adjust DTW_REF_DIST to shift the difficulty curve.

  pScore — pitch match via median F0 ratio:
    Compares the median fundamental frequency of voiced frames in each signal.
    A ratio of 1.0 (same pitch) → 100.  Falls back to 60 (neutral) if either
    signal has too few voiced frames to compute a reliable median.
    Note: laughter is often not very pitched, so this component may frequently
    fall back to 60 — that's expected and intentional.
*/
async function runAnalysis() {
  // Yield to the browser so the "analyzing…" prompt text can render
  await new Promise(r => setTimeout(r, 40));

  const tFeat = extractFeatures(targetBuf);
  const uFeat = extractFeatures(userBuf);

  // If the user stopped recording before the target ended, only compare the
  // portion of the target that corresponds to the recorded duration.
  // Both buffers share the same sample rate after decoding, so the frame
  // count scales linearly with duration.
  //   targetFramesToUse = tFeat.mfccs.length × (userDuration / targetDuration)
  // We clamp to the full target length so that longer recordings still compare
  // against the whole target (DTW handles the temporal stretch).
  const userDur   = userBuf.duration;
  const targetDur = targetBuf.duration;
  let tMfccs   = tFeat.mfccs;
  let tPitches = tFeat.pitches;
  if (userDur < targetDur) {
    const keepFrames = Math.round(tFeat.mfccs.length * (userDur / targetDur));
    tMfccs   = tFeat.mfccs.slice(0, keepFrames);
    tPitches = tFeat.pitches.slice(0, keepFrames);
  }

  // Console output for calibration — open DevTools to see raw distances
  // and tune DTW_REF_DIST accordingly.
  console.debug('[laughCAPTCHA] DTW distance:', dtw(tMfccs, uFeat.mfccs).toFixed(3));
  console.debug('[laughCAPTCHA] target frames used:', tMfccs.length, '/', tFeat.mfccs.length,
                '| voiced:', tPitches.filter(p => p > 0).length);
  console.debug('[laughCAPTCHA] user   frames:', uFeat.mfccs.length,
                '| voiced:', uFeat.pitches.filter(p => p > 0).length);

  // ── MFCC component ──
  const dist   = dtw(tMfccs, uFeat.mfccs);
  const mScore = Math.max(0, Math.min(100, 100 * Math.exp(-dist / DTW_REF_DIST)));

  // ── Pitch component ──
  const tv = tPitches.filter(p => p > 0);        // voiced frames only (trimmed target)
  const uv = uFeat.pitches.filter(p => p > 0);
  let pScore = 60;                                // neutral fallback
  if (tv.length > 3 && uv.length > 3) {
    tv.sort((a, b) => a - b); uv.sort((a, b) => a - b);
    const tm = tv[Math.floor(tv.length / 2)];    // median target pitch
    const um = uv[Math.floor(uv.length / 2)];    // median user pitch
    // Ratio of the smaller to the larger — 1.0 = perfect match, 0 = total mismatch
    pScore = 100 * Math.min(tm, um) / Math.max(tm, um);
  }

  const score = Math.round(Math.max(0, Math.min(100, 0.75 * mScore + 0.25 * pScore)));
  setState(S.RESULT, score);
}


/* ── State machine ───────────────────────────────────────────────────────── */
/*
  ALL UI updates live here.  This makes it easy to audit what is visible in
  each state without hunting through individual event handlers.

  Calling convention:
    setState(S.RESULT, score)  — pass data as second argument for states that need it
    setState(S.IDLE)           — no second argument for most states
*/
function setState(newState, data) {
  appState = newState;

  const playing   = newState === S.PLAYING;
  const ready     = newState === S.READY;
  const recording = newState === S.RECORDING;
  const analyzing = newState === S.ANALYZING;
  const result    = newState === S.RESULT;

  // Button enable/disable/visibility.
  // btn-hold enabled in READY (first record), RECORDING (mid-hold),
  // and RESULT (retry same target laugh without skipping).
  DOM.btnPlay.disabled     = playing || recording || analyzing;
  DOM.btnHold.disabled     = !(ready || recording || result);
  DOM.btnPlayUser.hidden   = !userBuf;
  DOM.btnPlayBoth.hidden   = !userBuf;
  DOM.btnRetry.hidden      = !result;
  DOM.btnHold.classList.toggle('recording', recording);
  DOM.scoreWrap.hidden     = !result;

  // Prompt text lookup — indexed by state name
  const msgs = {
    [S.IDLE]:      ['listen, then mimic the laugh', ''],
    [S.PLAYING]:   ['listen carefully\u2026',        ''],
    [S.READY]:     ['hold to record',               'hold the button while you laugh'],
    [S.RECORDING]: ['laughing\u2026',                `release when done \u2014 max ${targetBuf ? targetBuf.duration.toFixed(1) : MAX_RECORD_S}s`],
    [S.ANALYZING]: ['analyzing\u2026',               ''],
  };

  if (msgs[newState]) {
    [DOM.promptText.textContent, DOM.promptSub.textContent] = msgs[newState];
  }

  if (result) {
    const score  = data;
    lastScore    = score;   // stored so playback-finish can restore this state
    const passed = score >= PASS_SCORE;
    DOM.scoreVal.textContent   = score;
    DOM.scoreLabel.textContent = passed ? '\u2014 pass' : '\u2014 try again';
    DOM.scoreWrap.className    = passed ? 'pass' : 'fail';
    DOM.promptText.textContent = passed ? 'human confirmed.' : 'not quite.';
    DOM.promptSub.textContent  = `similarity: ${score}% \u2014 hold to retry or skip`;
    announce(`Score: ${score}%. ${passed ? 'Pass!' : 'Try again.'}`);
    if (passed) { solvedCount++; DOM.solvedCount.textContent = solvedCount; }
  }

  if (ready) announce('Target laugh finished. Hold the button to record your laugh.');
}


/* ── Screen-reader announce ──────────────────────────────────────────────── */
/*
  We blank the live region first, then set it in the next animation frame.
  This forces screen readers (NVDA, VoiceOver) to re-announce the text even
  if it hasn't changed — without the blank step, repeated identical messages
  are often swallowed.
*/
function announce(msg, err = false) {
  const target = err ? DOM.announceErr : DOM.announce;
  target.textContent = '';
  requestAnimationFrame(() => { target.textContent = msg; });
}


/* ── Event handlers ──────────────────────────────────────────────────────── */

// Play target laugh (keyboard shortcut: t)
DOM.btnPlay.addEventListener('click', () => {
  if (![S.IDLE, S.READY, S.RESULT].includes(appState)) return;
  setState(S.PLAYING);
  playTarget();
});

// Play user's recorded laugh
DOM.btnPlayUser.addEventListener('click', () => {
  if (!userBuf) return;
  playUser();
});

// Play both simultaneously
DOM.btnPlayBoth.addEventListener('click', () => playBoth());

// Hold to record — mouse
DOM.btnHold.addEventListener('mousedown', e => {
  if (appState !== S.READY && appState !== S.RESULT) return;
  e.preventDefault();
  setState(S.RECORDING);
  startRec();
});

document.addEventListener('mouseup', () => {
  if (appState === S.RECORDING) stopRec();
});

// Hold to record — touch (passive:false allows us to call preventDefault)
DOM.btnHold.addEventListener('touchstart', e => {
  if (appState !== S.READY && appState !== S.RESULT) return;
  e.preventDefault();
  setState(S.RECORDING);
  startRec();
}, { passive: false });

document.addEventListener('touchend', () => {
  if (appState === S.RECORDING) stopRec();
});

// Skip — load a fresh random target laugh; clears the current score
DOM.btnRetry.addEventListener('click', async () => {
  if (userBlobUrl) { URL.revokeObjectURL(userBlobUrl); userBlobUrl = null; }
  userBuf   = null;
  lastScore = null;   // no score for the new round; finish → READY, not RESULT
  wsUser.empty();
  DOM.scoreWrap.hidden = true;
  setState(S.IDLE);
  await loadTargetAudio();
});

// Keyboard shortcuts — t: play target, u: play user, b: play both, r: retry (hold to record), s: skip
document.addEventListener('keydown', e => {
  if (e.repeat || e.target.tagName === 'INPUT') return;
  if (e.key === 't' && !DOM.btnPlay.disabled)              { DOM.btnPlay.click();     return; }
  if (e.key === 'u' && !DOM.btnPlayUser.hidden)            { DOM.btnPlayUser.click(); return; }
  if (e.key === 'b' && !DOM.btnPlayBoth.hidden)            { DOM.btnPlayBoth.click(); return; }
  if (e.key === 's' && !DOM.btnRetry.hidden)               { DOM.btnRetry.click();    return; }
  if (e.key === 'r' && (appState === S.READY || appState === S.RESULT)) {
    e.preventDefault();
    DOM.btnHold.dispatchEvent(new MouseEvent('mousedown'));
  }
});

document.addEventListener('keyup', e => {
  if (e.key === 'r' && appState === S.RECORDING) {
    document.dispatchEvent(new MouseEvent('mouseup'));
  }
});

// Theme toggle — also re-colours WaveSurfer waveforms
DOM.btnTheme.addEventListener('click', () => {
  const root   = document.documentElement;
  const toLite = root.dataset.theme !== 'light';
  root.dataset.theme = toLite ? 'light' : 'dark';
  DOM.btnTheme.textContent = toLite ? 'dark' : 'light';
  DOM.btnTheme.setAttribute('aria-label',
    toLite ? 'switch to dark mode' : 'switch to light mode');

  const isDark = !toLite;
  const grads  = waveGradients(isDark);
  const cursor = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)';
  if (wsTarget) wsTarget.setOptions({ waveColor: grads.target.waveColor, progressColor: grads.target.progressColor, cursorColor: cursor });
  if (wsUser)   wsUser.setOptions({ waveColor: grads.user.waveColor,   progressColor: grads.user.progressColor,   cursorColor: cursor });
});

// About panel (Escape also closes)
DOM.btnAbout.addEventListener('click', () => { DOM.aboutPanel.hidden = false; DOM.btnBack.focus(); });
DOM.btnBack.addEventListener('click',  () => { DOM.aboutPanel.hidden = true;  DOM.btnAbout.focus(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !DOM.aboutPanel.hidden) {
    DOM.aboutPanel.hidden = true;
    DOM.btnAbout.focus();
  }
});


/* ── Permission + bootstrap ──────────────────────────────────────────────── */

DOM.btnAllow.addEventListener('click', async () => {
  DOM.btnAllow.disabled = true;
  DOM.permErr.hidden    = true;

  try {
    // getUserMedia prompts the browser permission dialog.
    // { audio: true } is minimal — no video needed.
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    DOM.permErr.textContent = err.name === 'NotAllowedError'
      ? 'Microphone access denied. Allow it in your browser settings and reload.'
      : `Microphone error: ${err.message}`;
    DOM.permErr.hidden    = false;
    DOM.btnAllow.disabled = false;
    return;
  }

  // AudioContext must be created after a user gesture — browsers enforce this
  // to prevent sites from auto-playing audio on load.
  audioCtx = new AudioContext();
  initWaveSurfers();
  await loadTargetAudio();   // picks a random file from 4o-fem-laughs/

  DOM.permScreen.hidden = true;
  setState(S.IDLE);
  announce('laughCAPTCHA ready. Press T to hear the target laugh.');
});


/* ════════════════════════════════════════════════════════════════════════════
   SKETCH: WaveSurfer.js Feature Expansion
   ────────────────────────────────────────────────────────────────────────────
   WaveSurfer v7 ships optional plugins loaded as ES modules.  The CDN build
   bundles them; tree-shakeable if you switch to npm + a bundler.

   The four most useful for this CAPTCHA:

   1. HOVER PLUGIN — shows a time tooltip as the mouse moves over the waveform.
      Useful so users can see exactly where their laugh diverges from the target's.

      import Hover from 'wavesurfer.js/dist/plugins/hover.js';
      wsTarget = WaveSurfer.create({
        ...options,
        plugins: [
          Hover.create({ lineColor: '#fff', labelBackground: '#333', labelColor: '#fff' })
        ]
      });

   2. TIMELINE PLUGIN — draws second markers below the waveform.
      Helps users visually anchor the timing of laugh bursts.

      import Timeline from 'wavesurfer.js/dist/plugins/timeline.js';
      wsTarget = WaveSurfer.create({
        ...options,
        plugins: [ Timeline.create({ height: 12, primaryLabelInterval: 0.5 }) ]
      });

   3. REGIONS PLUGIN — lets you programmatically mark sections of the waveform.
      Plan: after feature extraction, compute per-frame energy and mark the
      voiced regions on wsUser (amber highlights where you actually laughed).
      This would give instant visual feedback on whether the laugh was captured.

      import Regions from 'wavesurfer.js/dist/plugins/regions.js';
      const regionsPlugin = Regions.create();
      wsUser = WaveSurfer.create({ ...options, plugins: [regionsPlugin] });

      // After recording:
      const energyFrames = computeEnergyFrames(userBuf);  // roll-your-own
      energyFrames.forEach(({ start, end, voiced }) => {
        if (voiced) regionsPlugin.addRegion({ start, end, color: 'rgba(255,143,0,0.25)' });
      });

   4. MINIMAP PLUGIN — a small zoomed-out overview above or below the main
      waveform.  Only worthwhile if you add zoom (scroll-wheel or +/- buttons).

      import Minimap from 'wavesurfer.js/dist/plugins/minimap.js';
      wsTarget = WaveSurfer.create({
        ...options,
        plugins: [ Minimap.create({ height: 20, waveColor: '#333', progressColor: '#555' }) ]
      });

   To enable any of these:
     (a) Switch the CDN script tag to an ES module import map, or
     (b) Use the all-in-one CDN bundle and access window.WaveSurferPlugins.*.
   ════════════════════════════════════════════════════════════════════════════ */


/* ════════════════════════════════════════════════════════════════════════════
   SKETCH: Personal Laugh Tuning Interface
   ────────────────────────────────────────────────────────────────────────────
   Goal: let users hear the target laugh modified to be "closer to them" before
   they attempt to mimic it — a training aid / accessibility feature.

   THREE AXES OF TUNING:

   1. PLAYBACK RATE (pitch + speed together)
      The cheapest transform.  BufferSource.playbackRate is a Web Audio
      AudioParam — it changes both pitch and duration proportionally.
      Range: 0.5× (an octave down, twice as slow) to 2.0× (octave up, 2× speed).

      let tuneRate = 1.0;   // default: unchanged
      // In playTarget():
      src.playbackRate.value = tuneRate;
      // UI: <input type="range" min="0.5" max="2.0" step="0.05" id="tune-rate">

   2. PITCH SHIFT ONLY (rate-decoupled)
      Requires a pitch-shifting algorithm.  The simplest browser-native approach:
      use a PitchShifter AudioWorklet, or the phase-vocoder technique.
      A practical shortcut: load the audio into an OfflineAudioContext at a
      different sample rate, then play at a compensating playbackRate.
      This is the "poor-man's pitch shift" — not artifact-free but good enough
      for a demo.

      async function pitchShiftedBuf(buf, semitones) {
        const ratio = Math.pow(2, semitones / 12);
        const newSr = Math.round(buf.sampleRate * ratio);
        const offCtx = new OfflineAudioContext(1, buf.length, newSr);
        const src = offCtx.createBufferSource();
        src.buffer = buf;
        src.connect(offCtx.destination);
        src.start();
        const shifted = await offCtx.startRendering();
        return shifted;
      }

   3. FORMANT SHIFT (timbral change independent of pitch)
      The hardest and most expressive.  Requires a vocoder or LPC resynthesis.
      Out of scope for a lightweight demo — would need a WASM audio library
      (e.g. Rubberband.wasm) or an AudioWorklet with custom DSP.

   UI SKETCH:
   ──────────
   Add a collapsible "tune" panel below the waveforms, hidden until the user
   clicks a "tune" button (only available in IDLE / READY states).

   <div id="tune-panel" hidden>
     <label>speed / pitch  <input type="range" id="tune-rate" min="0.5" max="2.0" step="0.05" value="1"></label>
     <label>pitch offset   <input type="range" id="tune-pitch" min="-6" max="6" step="1" value="0"> semitones</label>
     <button id="btn-tune-preview">preview</button>
     <button id="btn-tune-reset">reset</button>
   </div>

   Wire-up sketch:
   ───────────────
   let tuneRate = 1.0, tuneSemitones = 0;

   el('tune-rate').addEventListener('input', e => {
     tuneRate = parseFloat(e.target.value);
   });

   el('btn-tune-preview').addEventListener('click', async () => {
     const shifted = await pitchShiftedBuf(targetBuf, tuneSemitones);
     const src = audioCtx.createBufferSource();
     src.buffer = shifted;
     src.playbackRate.value = tuneRate;
     src.connect(audioCtx.destination);
     src.start();
   });

   el('btn-tune-reset').addEventListener('click', () => {
     tuneRate = 1.0; tuneSemitones = 0;
     el('tune-rate').value  = '1';
     el('tune-pitch').value = '0';
   });

   The tuned version would ONLY affect playback — the comparison always runs
   against the original targetBuf so the CAPTCHA difficulty stays consistent.
   ════════════════════════════════════════════════════════════════════════════ */
