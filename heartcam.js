const video    = document.getElementById('videoElement');
const ampVideo = document.getElementById('amplifiedVideoElement');
const canvas   = document.getElementById('canvas');
const message  = document.getElementById('message');
const info     = document.getElementById('info');

// const fftCanvas   = document.getElementById('heartRateChart');
const pulseCanvas = document.getElementById('pulseChart');
// const fftCtx      = fftCanvas.getContext('2d');
const pulseCtx    = pulseCanvas.getContext('2d');

let pulseHistory = [];
const pulseChartDuration = 10;

const context   = canvas.getContext('2d');
const ampContext = ampVideo.getContext('2d');

function resizeCanvas () {
  ampVideo.width  = video.videoWidth;
  ampVideo.height = video.videoHeight;
}
window.addEventListener('resize', resizeCanvas);

// ── Signal / detection constants ─────────────────────────────────────────────

const bufferSize = 560;
const samplingTime = 10;
const abandonTime = 0;
const abandonPerFrame = 1;
const abandonPerFrameAfterSamplingTime = 2;
const freqMin = 0.66;
const freqMax = 3;

let signal            = [];
let fingerDetected    = false;
let countdownStartTime = null;
let smoothedHeartRate = null;
let popSignal         = 0;
let smoothedBrightness = null;
let ampVideoBrightness = 0;
let lastPulseTime     = Date.now();

// ── Logging ───────────────────────────────────────────────────────────────────

let logs = [];

function updateDataPointsInfo () {
  document.getElementById('dataPointsInfo').textContent = `Data points sampled: ${logs.length}`;
}
function addLogEntry (data) {
  logs.push({ timestamp: new Date().toISOString(), ...data });
  updateDataPointsInfo();
}
function clearLog () { logs = []; updateDataPointsInfo(); }
function downloadLog () {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(logs, null, 2));
  const a = document.createElement('a');
  a.setAttribute('href', dataStr);
  a.setAttribute('download', `heartcam_log_${new Date().toISOString()}.json`);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

document.getElementById('clearLogButton').addEventListener('click', clearLog);
document.getElementById('downloadLogButton').addEventListener('click', downloadLog);

// ── Canvas chart sizing ───────────────────────────────────────────────────────

function sizeCavas (cnv, h) {
  const w = cnv.parentElement.clientWidth || 600;
  if (cnv.width !== w || cnv.height !== h) {
    cnv.width  = w;
    cnv.height = h;
  }
}

// ── Vanilla FFT chart ─────────────────────────────────────────────────────────
//   Draws: grid, axes, spectrum line, dashed BPM marker + label

function drawFFT (freqsBpm, magnitudes, smoothedBpm) {
  sizeCavas(fftCanvas, 260);
  const ctx  = fftCtx;
  const W    = fftCanvas.width;
  const H    = fftCanvas.height;
  const pad  = { top: 16, right: 24, bottom: 44, left: 48 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top  - pad.bottom;

  const bpmMin = Math.round(freqMin * 60); // 40
  const bpmMax = Math.round(freqMax * 60); // 180

  const xOf = bpm => pad.left + (bpm - bpmMin) / (bpmMax - bpmMin) * plotW;
  const yOf = mag => pad.top  + (1 - mag) * plotH;

  // — background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, 0, W, H);

  // — grid
  ctx.strokeStyle = 'rgba(187,187,187,0.15)';
  ctx.lineWidth = 1;

  for (let bpm = bpmMin; bpm <= bpmMax; bpm += 10) {
    const x = xOf(bpm);
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke();
  }
  for (const mag of [0.25, 0.5, 0.75, 1.0]) {
    const y = yOf(mag);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
  }

  // — axes
  ctx.strokeStyle = 'rgba(187,187,187,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + plotH);
  ctx.lineTo(pad.left + plotW, pad.top + plotH);
  ctx.stroke();

  // — tick labels (x every 20 BPM)
  ctx.fillStyle = 'rgba(187,187,187,0.8)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let bpm = bpmMin; bpm <= bpmMax; bpm += 20) {
    ctx.fillText(bpm, xOf(bpm), pad.top + plotH + 6);
  }

  // — x axis title
  ctx.fillStyle = 'rgba(187,187,187,0.9)';
  ctx.font = '12px sans-serif';
  ctx.fillText('Heart Rate (BPM)', pad.left + plotW / 2, pad.top + plotH + 24);

  // — y tick labels
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '10px sans-serif';
  ctx.fillStyle = 'rgba(187,187,187,0.7)';
  for (const mag of [0, 0.5, 1.0]) {
    ctx.fillText(mag.toFixed(1), pad.left - 6, yOf(mag));
  }

  // — y axis title (rotated)
  ctx.save();
  ctx.translate(12, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '11px sans-serif';
  ctx.fillStyle = 'rgba(187,187,187,0.9)';
  ctx.fillText('Normalized Magnitude', 0, 0);
  ctx.restore();

  // — spectrum line
  if (freqsBpm.length >= 2) {
    ctx.beginPath();
    ctx.strokeStyle = '';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (let i = 0; i < freqsBpm.length; i++) {
      const x = xOf(freqsBpm[i]);
      const y = yOf(magnitudes[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // subtle fill under the curve
    ctx.lineTo(xOf(freqsBpm.at(-1)), pad.top + plotH);
    ctx.lineTo(xOf(freqsBpm[0]),     pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(187,187,187,0.08)';
    ctx.fill();
  }

  // — BPM marker: dashed vertical line + label
  if (smoothedBpm !== null && isFinite(smoothedBpm)) {
    const x = xOf(smoothedBpm);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(0,255,0,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    const label = `${smoothedBpm.toFixed(1)} BPM`;
    ctx.font = 'bold 13px sans-serif';
    const tw = ctx.measureText(label).width;
    // flip label to left side if too close to right edge
    const lx = (x + tw + 12 > pad.left + plotW) ? x - tw - 8 : x + 8;
    ctx.fillStyle = 'rgba(18,18,18,0.85)';
    ctx.fillRect(lx - 2, pad.top + 6, tw + 4, 18);
    ctx.fillStyle = 'rgba(0,255,0,1)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, lx, pad.top + 8);
    ctx.restore();
  }
}

// ── Vanilla pulse chart ───────────────────────────────────────────────────────
//   Draws: rolling 10-second pulse waveform

function drawPulse (history) {

  /*
  
  i want this to be less medical, less sterile...

  */

  sizeCavas(pulseCanvas, 90);
  const ctx  = pulseCtx;
  const W    = pulseCanvas.width;
  const H    = pulseCanvas.height;
  const pad  = { top: 8, right: 16, bottom: 28, left: 16 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top  - pad.bottom;

  const nowSec = Date.now() / 1000;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, 0, W, H);

  // — baseline
  ctx.strokeStyle = 'rgba(187,187,187,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top + plotH);
  ctx.lineTo(pad.left + plotW, pad.top + plotH);
  ctx.stroke();

  // — time labels (0s ... 10s reversed)
  ctx.fillStyle = 'white';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let t = 0; t <= pulseChartDuration; t += 2) {
    const x = pad.left + (t / pulseChartDuration) * plotW;
    ctx.fillText(`${pulseChartDuration - t}s`, x, pad.top + plotH + 6);
  }

  // — pulse waveform
  const recent = history.filter(p => p.time / 1000 > nowSec - pulseChartDuration);
  if (recent.length < 2) return;

  ctx.beginPath();
  ctx.strokeStyle = '#dddddd';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';

  for (let i = 0; i < recent.length; i++) {
    const elapsed = recent[i].time / 1000 - nowSec + pulseChartDuration;
    const x = pad.left + (elapsed / pulseChartDuration) * plotW;
    const y = pad.top  + (1 - recent[i].value) * plotH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ── Pulse chart update (called each frame) ────────────────────────────────────

function updatePulseChart () {
  const currentTime = Date.now() / 1000;
  pulseHistory = pulseHistory.filter(p => p.time / 1000 > currentTime - pulseChartDuration);
  drawPulse(pulseHistory);
}

// ── Peak detection ────────────────────────────────────────────────────────────

function findPeaks (minFreq, maxFreq, filteredFreqs, filteredMagnitudes) {
  let peakIndex = null;
  for (let i = 0; i < filteredFreqs.length; ++i) {
    if (filteredFreqs[i] < minFreq) continue;
    if (filteredFreqs[i] > maxFreq) break;
    if (filteredMagnitudes[i] < 0.75) continue;
    if (peakIndex === null || filteredMagnitudes[i] > filteredMagnitudes[peakIndex]) {
      peakIndex = i;
    }
  }
  return peakIndex;
}

// ── Camera stream ─────────────────────────────────────────────────────────────

function startVideoStream () {
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
    .then(stream => {
      video.srcObject = stream;
      video.play();
      video.addEventListener('loadedmetadata', () => {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        requestAnimationFrame(processFrame);
      });
    })
    .catch(() => {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(stream => {
          video.srcObject = stream;
          video.play();
          video.addEventListener('loadedmetadata', () => {
            canvas.width  = video.videoWidth;
            canvas.height = video.videoHeight;
            requestAnimationFrame(processFrame);
          });
        })
        .catch(err => {
          message.textContent = 'Error accessing the camera: ' + err.name;
          message.style.color = 'red';
        });
    });
}

startVideoStream();

// ── Main frame loop ───────────────────────────────────────────────────────────

function processFrame () {
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    requestAnimationFrame(processFrame);
    return;
  }

  resizeCanvas();

  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const frame = context.getImageData(0, 0, canvas.width, canvas.height);

  const redDominancePercentage = extractRedDominance(frame);

  if (redDominancePercentage >= 99.95 && extractBrightnessDifference(frame) < 80) {
    if (!fingerDetected) {
      fingerDetected      = true;
      countdownStartTime  = Date.now();
      signal              = [];
    }

    const rgbAverage = extractRGBAverage(frame);
    const timestamp  = Date.now();
    signal.push({ value: rgbAverage, time: timestamp / 1000 });

    if (signal.length > bufferSize) signal.shift();

    const timeDiff     = signal[signal.length - 1].time - signal[0].time;
    const samplingRate = signal.length / (timeDiff || 1);

    smoothedBrightness = smoothedBrightness === null
      ? rgbAverage
      : expSmooth(smoothedBrightness, rgbAverage, samplingRate, 20);

    if (rgbAverage > smoothedBrightness || lastPulseTime + 1 / (smoothedHeartRate / 60) * 2 / 3 * 1000 > Date.now()) {
      ampVideoBrightness = expSmooth(ampVideoBrightness, 0, samplingRate, 10);
    } else {
      ampVideoBrightness = 0.5;
      lastPulseTime = timestamp;
    }

    addLogEntry({ pulse: ampVideoBrightness / 0.5, bpm: smoothedHeartRate });
    pulseHistory.push({ time: timestamp, value: (ampVideoBrightness / 0.5) ** 3 });

    ampContext.fillStyle = `rgb(${187 * ampVideoBrightness}, ${187 * ampVideoBrightness}, ${187 * ampVideoBrightness})`;
    ampContext.fillRect(0, 0, ampVideo.width, ampVideo.height);

    updatePulseChart();

    info.innerHTML = `Sampling Rate: ${samplingRate.toFixed(2)} Hz, Buffer Size: ${signal.length}<br>GENTLY place your FINGERTIP on the camera, hold still, DO NOT move, and wait until the buffer size reaches ${bufferSize}.`;

    const elapsedTime = (Date.now() - countdownStartTime) / 1000;

    if (elapsedTime < samplingTime) {
      message.textContent = 'Hold still and cover the camera...';
      message.style.color = 'rgba(0, 255, 0, 1)';
    }

    if (elapsedTime > abandonTime) {
      const drainRate = elapsedTime < samplingTime ? abandonPerFrame : abandonPerFrameAfterSamplingTime;
      if (popSignal >= drainRate) { signal.shift(); popSignal = 0; }
      else popSignal++;
    }

    if (elapsedTime > Math.max(abandonTime, 1)) {
      const result             = getFFT(signal, samplingRate);
      const filteredFreqs      = result.freqs;
      const filteredMagnitudes = result.magnitudes;

      let tempPeakIndex = filteredMagnitudes.indexOf(Math.max(...filteredMagnitudes));
      let peakIndex     = null;

      if (filteredFreqs[tempPeakIndex] > 120.0 / 60) {
        peakIndex = findPeaks(
          filteredFreqs[tempPeakIndex] / 2.0 - 10.0 / 60,
          filteredFreqs[tempPeakIndex] / 2.0 + 10.0 / 60,
          filteredFreqs, filteredMagnitudes
        );
      }
      if (filteredFreqs[tempPeakIndex] < 50.0 / 60) {
        peakIndex = findPeaks(60.0 / 60, 100.0 / 60, filteredFreqs, filteredMagnitudes);
      }
      if (peakIndex === null) peakIndex = tempPeakIndex;

      // weighted average of peak ± 1 bin
      const idxs = [peakIndex];
      if (peakIndex > 0)                        idxs.push(peakIndex - 1);
      if (peakIndex < filteredFreqs.length - 1) idxs.push(peakIndex + 1);
      const magSum      = idxs.reduce((acc, i) => acc + filteredMagnitudes[i], 0);
      const heartRateBpm = 60 * idxs.reduce((acc, i) => acc + filteredFreqs[i] * (filteredMagnitudes[i] / magSum), 0);

      if (smoothedHeartRate === null || Number.isNaN(smoothedHeartRate)) {
        smoothedHeartRate = heartRateBpm;
      } else {
        smoothedHeartRate = expSmooth(smoothedHeartRate, heartRateBpm, samplingRate);
      }
      if (Number.isNaN(smoothedHeartRate)) smoothedHeartRate = 70;

      // drawFFT(filteredFreqs.map(f => f * 60), filteredMagnitudes, smoothedHeartRate);

      message.textContent = `Heart Rate: ${smoothedHeartRate.toFixed(1)} bpm`;
      message.style.color = 'rgba(0, 255, 0, 1)';
    }

  } else {
    lastPulseTime      = Date.now();
    fingerDetected     = false;
    countdownStartTime = null;
    popSignal          = 0;
    message.innerHTML  = '1. Place your device and elbow on a stable surface.<br>2. GENTLY place your FINGERTIP on the camera. DO NOT PRESS HARD.<br>3. Hold still and COVER the camera with steady pressure...';
    message.style.color = 'rgba(187, 187, 187, 1)';
    info.textContent    = '';
  }

  requestAnimationFrame(processFrame);
}

// ── Frame analysis ────────────────────────────────────────────────────────────

function extractRedDominance (frame) {
  const d = frame.data;
  let redDominantPixels = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > d[i + 1] && d[i] > d[i + 2]) redDominantPixels++;
  }
  return (redDominantPixels / (d.length / 4)) * 100;
}

function extractRGBAverage (frame) {
  const d = frame.data;
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    total += (d[i] + d[i + 1] + d[i + 2]) / 3;
  }
  return total / (d.length / 4);
}

function extractBrightnessDifference (frame) {
  const d = frame.data;
  const brightnessValues = [];
  const sampleRate = 0.01;
  for (let i = 0; i < d.length; i += (4 / sampleRate)) {
    const idx = Math.floor(i);
    brightnessValues.push((d[idx] + d[idx + 1] + d[idx + 2]) / 3);
  }

  function quickselect (arr, k) {
    if (arr.length === 1) return arr[0];
    const pivot  = arr[Math.floor(arr.length / 2)];
    const lows   = arr.filter(x => x < pivot);
    const highs  = arr.filter(x => x > pivot);
    const pivots = arr.filter(x => x === pivot);
    if (k < lows.length)                        return quickselect(lows,  k);
    else if (k < lows.length + pivots.length)   return pivot;
    else                                         return quickselect(highs, k - lows.length - pivots.length);
  }

  const n = brightnessValues.length;
  return quickselect(brightnessValues, Math.floor(0.95 * n))
       - quickselect(brightnessValues, Math.floor(0.05 * n));
}

function expSmooth (currentRate, newRate, samplingRate, alpha = 1) {
  return 0.52 / samplingRate * alpha * newRate + (1 - 0.52 / samplingRate * alpha) * currentRate;
}

// ── FFT ───────────────────────────────────────────────────────────────────────

function getFFT (signal, samplingRate) {
  const values  = signal.map(p => p.value);
  const n       = values.length;
  const size    = Math.pow(2, Math.floor(Math.log2(n)));
  const startIdx = n - size;
  const latest  = values.slice(startIdx, n);

  const mean    = latest.reduce((a, b) => a + b, 0) / size;
  const zeroed  = latest.map(v => v - mean);

  const fftResult = fft(zeroed);

  const frequencies = [];
  for (let i = 0; i < fftResult.length / 2; i++) {
    frequencies.push(i * samplingRate / fftResult.length);
  }

  const magnitudes = fftResult.slice(0, fftResult.length / 2)
    .map(c => Math.sqrt(c.real * c.real + c.imag * c.imag));

  const filteredFreqs = [], filteredMagnitudes = [];
  for (let i = 0; i < frequencies.length; i++) {
    if (frequencies[i] >= freqMin && frequencies[i] <= freqMax) {
      filteredFreqs.push(frequencies[i]);
      filteredMagnitudes.push(magnitudes[i]);
    }
  }

  const maxMagnitude = Math.max(...filteredMagnitudes);
  return {
    freqs:      filteredFreqs,
    magnitudes: maxMagnitude ? filteredMagnitudes.map(m => m / maxMagnitude) : filteredMagnitudes,
  };
}

function fft (buffer) {
  const n = buffer.length;
  if (n <= 1) return [{ real: buffer[0], imag: 0 }];
  if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of 2');

  const half = n / 2;
  const even = new Array(half), odd = new Array(half);
  for (let i = 0; i < half; i++) { even[i] = buffer[2 * i]; odd[i] = buffer[2 * i + 1]; }

  const evenFFT = fft(even);
  const oddFFT  = fft(odd);
  const result  = new Array(n);

  for (let k = 0; k < half; k++) {
    const angle = -2 * Math.PI * k / n;
    const t     = { real: Math.cos(angle), imag: Math.sin(angle) };
    const tw    = {
      real: t.real * oddFFT[k].real - t.imag * oddFFT[k].imag,
      imag: t.real * oddFFT[k].imag + t.imag * oddFFT[k].real,
    };
    result[k]        = { real: evenFFT[k].real + tw.real, imag: evenFFT[k].imag + tw.imag };
    result[k + half] = { real: evenFFT[k].real - tw.real, imag: evenFFT[k].imag - tw.imag };
  }
  return result;
}
