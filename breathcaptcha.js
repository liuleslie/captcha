// breathcaptcha.js
// Detects a single breath event on the webcam lens via 2-D spatial FFT.
// A breath fogs the lens, collapsing high-frequency energy in the magnitude
// spectrum. Detection requires the energy to drop AND recover, proving a
// real transient fog event rather than a static obstruction or replay.
//
// API:
//   BreathCaptcha.init({ video, onVerified, onStatus })
//   BreathCaptcha.start()
//   BreathCaptcha.reset()
//   BreathCaptcha.state   → current state string
//   BreathCaptcha.STATES  → state label constants

window.BreathCaptcha = (function () {
  'use strict';

  // ── Tuning ────────────────────────────────────────────────────────────────
  const N             = 64;    // FFT grid (power-of-2; video downsampled to N×N)
  const BASELINE_LEN  = 60;    // frames to collect before arming  (~2 s @ 30 fps)
  const SUSTAIN_NEED      = 10;   // consecutive drop frames to confirm breath onset
  const DROP_THRESH       = 0.22; // HF must fall ≥22 % below baseline to trigger (rejects shallow approach)
  const MIN_DROP_DEPTH    = 0.30; // HF must reach ≥30 % below baseline at some point during BREATH
  const RECOVER_RATIO     = 0.90; // HF must return to ≥90 % of baseline to clear
  const MIN_RECOVERY      = 20;   // recovery slice must span ≥20 frames (~667 ms @ 30 fps)
  const MAX_STEP_CONTRIB  = 0.40; // any single frame may contribute ≤40 % of total rise (rejects abrupt unblocking)
  const MAX_BREATH_FRAMES = 300;  // abort BREATH state after ~10 s with no valid recovery
  const MIN_HF_FLOOR  = 0.04;  // minimum baseline HF ratio required to arm (rejects dark/flat scenes)
  const FPS_CAP       = 30;
  const FRAME_MS      = 1000 / FPS_CAP;

  // HF band in the unshifted 2-D FFT: indices [N/4, 3N/4) on both axes.
  // In the unshifted spectrum DC sits at (0,0) and high spatial frequencies
  // cluster near (N/2, N/2), so this square selects the high-freq region.
  const HF_LO = N >> 2;        // 16
  const HF_HI = (3 * N) >> 2; // 48

  // ── States ────────────────────────────────────────────────────────────────
  const S = {
    IDLE:      'idle',
    BASELINE:  'baseline',
    LISTENING: 'listening',
    BREATH:    'breath',
    VERIFIED:  'verified',
  };

  // ── Module-level state ────────────────────────────────────────────────────
  let _state       = S.IDLE;
  let _video       = null;
  let _offCvs      = null;
  let _offCtx      = null;
  let _rafId       = null;
  let _lastTime    = 0;
  let _baseline    = [];      // rolling buffer of recent HF ratios
  let _baselineHF  = 0;       // mean of _baseline
  let _sustainCnt  = 0;
  let _recoveryBuf = [];      // HF ratios collected during BREATH state
  let _breathMinHF = Infinity; // lowest HF seen in BREATH state (must reach MIN_DROP_DEPTH)
  let _onVerified  = null;
  let _onStatus    = null;    // fn(state, hfRatio, baselineHF) — optional live feed

  // Preallocated FFT buffers (N is fixed, so no per-frame allocation)
  const _re    = new Float64Array(N * N);
  const _im    = new Float64Array(N * N);
  const _rowRe = new Float64Array(N);
  const _rowIm = new Float64Array(N);
  const _colRe = new Float64Array(N);
  const _colIm = new Float64Array(N);
  // fftshifted log-magnitude spectrum written each frame, passed to onStatus
  const _fftMag = new Float32Array(N * N);

  // ── 1-D in-place radix-2 DIT FFT ─────────────────────────────────────────
  function fft1d(re, im) {
    const n = re.length;

    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t;
        t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    // Cooley-Tukey butterfly
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wRe = Math.cos(ang);
      const wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cRe = 1, cIm = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j++) {
          const uRe = re[i + j],        uIm = im[i + j];
          const vRe = re[i + j + half], vIm = im[i + j + half];
          const tvRe = vRe * cRe - vIm * cIm;
          const tvIm = vRe * cIm + vIm * cRe;
          re[i + j]        = uRe + tvRe;
          im[i + j]        = uIm + tvIm;
          re[i + j + half] = uRe - tvRe;
          im[i + j + half] = uIm - tvIm;
          const nextCRe = cRe * wRe - cIm * wIm;
          cIm = cRe * wIm + cIm * wRe;
          cRe = nextCRe;
        }
      }
    }
  }

  // ── 2-D FFT → HF energy ratio ─────────────────────────────────────────────
  // gray: Float32Array of N*N luma values [0..255]
  // returns: scalar in [0, 1] — fraction of total spectral magnitude in HF band
  function computeHFRatio(gray) {
    for (let i = 0; i < N * N; i++) { _re[i] = gray[i]; _im[i] = 0; }

    // Row-wise FFTs
    for (let r = 0; r < N; r++) {
      const off = r * N;
      for (let c = 0; c < N; c++) { _rowRe[c] = _re[off + c]; _rowIm[c] = 0; }
      fft1d(_rowRe, _rowIm);
      for (let c = 0; c < N; c++) { _re[off + c] = _rowRe[c]; _im[off + c] = _rowIm[c]; }
    }

    // Column-wise FFTs
    for (let c = 0; c < N; c++) {
      for (let r = 0; r < N; r++) { _colRe[r] = _re[r * N + c]; _colIm[r] = _im[r * N + c]; }
      fft1d(_colRe, _colIm);
      for (let r = 0; r < N; r++) { _re[r * N + c] = _colRe[r]; _im[r * N + c] = _colIm[r]; }
    }

    // Accumulate magnitudes: HF band vs total; build fftshifted log-mag for display
    let hf = 0, total = 0, maxLog = 0;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const idx = r * N + c;
        const mag = Math.sqrt(_re[idx] * _re[idx] + _im[idx] * _im[idx]);
        total += mag;
        if (r >= HF_LO && r < HF_HI && c >= HF_LO && c < HF_HI) hf += mag;
        // fftshift: move DC from (0,0) to (N/2, N/2) for intuitive display
        const sr = (r + (N >> 1)) % N;
        const sc = (c + (N >> 1)) % N;
        const logMag = Math.log(1 + mag);
        _fftMag[sr * N + sc] = logMag;
        if (logMag > maxLog) maxLog = logMag;
      }
    }
    // Normalize to [0, 1] so the renderer doesn't need to know the scale
    if (maxLog > 0) {
      for (let i = 0; i < N * N; i++) _fftMag[i] /= maxLog;
    }
    return total < 1e-6 ? 0 : hf / total;
  }

  // ── Video → 64×64 grayscale ───────────────────────────────────────────────
  const _gray = new Float32Array(N * N);

  function extractGray() {
    _offCtx.drawImage(_video, 0, 0, N, N);
    const px = _offCtx.getImageData(0, 0, N, N).data;
    for (let i = 0; i < N * N; i++) {
      const o = i * 4;
      _gray[i] = px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114;
    }
    return _gray;
  }

  // ── Baseline ──────────────────────────────────────────────────────────────
  function pushBaseline(ratio) {
    _baseline.push(ratio);
    if (_baseline.length > BASELINE_LEN) _baseline.shift();
    let sum = 0;
    for (let i = 0; i < _baseline.length; i++) sum += _baseline[i];
    _baselineHF = sum / _baseline.length;
  }

  // ── Recovery curve validator ──────────────────────────────────────────────
  // Finds the fog minimum inside buf, then checks that no single frame
  // contributes more than MAX_STEP_CONTRIB of the total rise back to baseline.
  // A face retreat produces one frame ≈ 100 % of total rise → rejected.
  // Real fog dissipation spreads the rise across many frames → passes.
  function validateRecovery(buf) {
    // Locate the fog minimum (deepest point)
    let minIdx = 0;
    for (let i = 1; i < buf.length; i++) {
      if (buf[i] < buf[minIdx]) minIdx = i;
    }
    const slice = buf.slice(minIdx);
    if (slice.length < MIN_RECOVERY) return false;
    const totalRise = slice[slice.length - 1] - slice[0];
    if (totalRise <= 0) return false;
    for (let i = 1; i < slice.length; i++) {
      const delta = slice[i] - slice[i - 1];
      if (delta > 0 && delta / totalRise > MAX_STEP_CONTRIB) return false;
    }
    return true;
  }

  // ── State transition (resets counters) ────────────────────────────────────
  function to(next) {
    _state       = next;
    _sustainCnt  = 0;
    _recoveryBuf = [];
    _breathMinHF = Infinity;
  }

  // ── Per-frame logic ───────────────────────────────────────────────────────
  function tick(ts) {
    _rafId = requestAnimationFrame(tick);

    if (_state === S.IDLE || _state === S.VERIFIED) return;
    if (ts - _lastTime < FRAME_MS) return;
    _lastTime = ts;
    if (_video.readyState < _video.HAVE_CURRENT_DATA || !_video.videoWidth) return;

    const ratio = computeHFRatio(extractGray());
    let progress = 0;  // recovery progress passed to UI (0–1, only meaningful in BREATH)

    // ── BASELINE ───────────────────────────────────────────────────────────
    if (_state === S.BASELINE) {
      pushBaseline(ratio);
      if (_baseline.length >= BASELINE_LEN) {
        if (_baselineHF < MIN_HF_FLOOR) _baseline = [];
        else to(S.LISTENING);
      }

    // ── LISTENING ──────────────────────────────────────────────────────────
    } else if (_state === S.LISTENING) {
      pushBaseline(ratio);
      const drop = (_baselineHF - ratio) / _baselineHF;
      if (drop >= DROP_THRESH) {
        if (++_sustainCnt >= SUSTAIN_NEED) to(S.BREATH);
      } else {
        _sustainCnt = 0;
      }

    // ── BREATH ─────────────────────────────────────────────────────────────
    } else if (_state === S.BREATH) {
      _recoveryBuf.push(ratio);
      if (ratio < _breathMinHF) _breathMinHF = ratio;

      if (_recoveryBuf.length > MAX_BREATH_FRAMES) {
        to(S.LISTENING);
      } else {
        const deepEnough = _breathMinHF <= _baselineHF * (1 - MIN_DROP_DEPTH);
        const recovered  = ratio >= _baselineHF * RECOVER_RATIO;

        if (recovered) {
          // progress = frames collected since the fog minimum / MIN_RECOVERY
          const minIdx = _recoveryBuf.reduce((m, v, i, a) => v < a[m] ? i : m, 0);
          progress = Math.min((_recoveryBuf.length - minIdx) / MIN_RECOVERY, 1);
        }

        if (deepEnough && recovered && validateRecovery(_recoveryBuf)) {
          _state = S.VERIFIED;
          if (_onStatus) _onStatus(_state, ratio, _baselineHF, _fftMag, 1);
          cancelAnimationFrame(_rafId);
          _rafId = null;
          if (_onVerified) _onVerified();
          return;
        }
      }
    }

    if (_onStatus) _onStatus(_state, ratio, _baselineHF, _fftMag, progress);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    STATES: S,

    // options.video      — HTMLVideoElement (required)
    // options.onVerified — fn() called once when breath verified
    // options.onStatus   — fn(state, hfRatio, baselineHF) called each frame
    init(options) {
      _video      = options.video;
      _onVerified = options.onVerified || null;
      _onStatus   = options.onStatus   || null;

      _offCvs        = document.createElement('canvas');
      _offCvs.width  = N;
      _offCvs.height = N;
      _offCtx = _offCvs.getContext('2d', { willReadFrequently: true });

      _state = S.IDLE;
      _baseline = [];
      _baselineHF = _sustainCnt = 0;
      _recoveryBuf = [];
    },

    // Begin baseline capture, then arm detection.
    start() {
      if (_state !== S.IDLE) return;
      _baseline    = [];
      _recoveryBuf = [];
      _lastTime    = 0;
      _sustainCnt  = 0;
      to(S.BASELINE);
      _rafId = requestAnimationFrame(tick);
    },

    // Return to IDLE and cancel any running loop.
    reset() {
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
      _state = S.IDLE;
      _baseline = [];
      _sustainCnt = _recoveryCnt = 0;
    },

    get state()      { return _state; },
    get baselineHF() { return _baselineHF; },
  };
}());
