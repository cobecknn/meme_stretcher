// meme stretcher — periodically stretch/compress an image along user-defined axes.
//
// Each axis has a direction, a max multiplier M, a cycle duration, and a curve of
// tensity v(t) in [-1, 1] over one cycle. The scale along the axis is M^v, so
// v = 1 stretches to M×, v = 0 leaves it alone, and v = -1 compresses to 1/M×.

const AXIS_COLORS = ['#ff5fa2', '#4fc3f7', '#ffd54f', '#81c784', '#ba68c8', '#ff8a65'];

const PRESETS = {
  sine: { interp: 'smooth', pts: [[0, 0], [0.25, 1], [0.5, 0], [0.75, -1]] },
  pulse: { interp: 'smooth', pts: [[0, 0], [0.08, 1], [0.3, 0]] },
  bounce: { interp: 'smooth', pts: [[0, 1], [0.5, -1]] },
  saw: { interp: 'linear', pts: [[0, -1], [0.95, 1]] },
  square: { interp: 'step', pts: [[0, 1], [0.5, -1]] },
  stretchOnly: { interp: 'smooth', pts: [[0, 0], [0.5, 1]] },
  squashOnly: { interp: 'smooth', pts: [[0, 0], [0.5, -1]] },
  flat: { interp: 'linear', pts: [[0, 0]] },
};

const state = {
  img: null,
  axes: [],
  playing: true,
  clockStart: performance.now(),
  pausedAt: 0,
  bg: '#16161d',
  transparent: false,
  fit: 0.5,
  guides: true,
  exporting: false,
  videoRec: null, // { ctx, W, H, k, start } while a video export is running
  original: null, // image as first loaded, for "Reset image"
  history: [], // previous images, for "Undo cut"
  cutting: false,
  lasso: null, // { pts: [{x, y}] in image px, cursor: {px, py} in display px }
  view: { k: 1 }, // current display scale (display px per image px)
};

let nextAxisId = 1;

// ---------- curve math ----------

function makePoints(preset) {
  return PRESETS[preset].pts.map(([t, v]) => ({ t, v }));
}

// Periodic interpolation: the curve wraps from the last point back to the first.
function evalCurve(pts, interp, x) {
  const n = pts.length;
  if (n === 0) return 0;
  if (n === 1) return pts[0].v;

  let a, b, ta, tb;
  if (x < pts[0].t) {
    a = pts[n - 1]; b = pts[0];
    ta = a.t - 1; tb = b.t;
  } else {
    let i = 0;
    while (i + 1 < n && pts[i + 1].t <= x) i++;
    a = pts[i];
    if (i + 1 < n) { b = pts[i + 1]; tb = b.t; }
    else { b = pts[0]; tb = b.t + 1; }
    ta = a.t;
  }
  const u = tb > ta ? (x - ta) / (tb - ta) : 0;
  let e;
  if (interp === 'linear') e = u;
  else if (interp === 'step') e = 0;
  else e = (1 - Math.cos(Math.PI * u)) / 2;
  return a.v + (b.v - a.v) * e;
}

function currentTime() {
  return (state.playing ? performance.now() - state.clockStart : state.pausedAt) / 1000;
}

function axisPhase(axis, time) {
  return ((time / axis.duration) % 1 + 1) % 1;
}

// 2x2 matrix [a, b, c, d] in canvas setTransform order: x' = a x + c y, y' = b x + d y.
function axisMatrix(axis, time) {
  const v = evalCurve(axis.pts, axis.interp, axisPhase(axis, time));
  const s = Math.pow(axis.mult, v);
  const p = axis.preserve ? 1 / s : 1;
  // Screen y points down, so negate the angle to make 45° point up-right.
  const th = (-axis.angle * Math.PI) / 180;
  const c = Math.cos(th), sn = Math.sin(th);
  const m11 = s * c * c + p * sn * sn;
  const m22 = s * sn * sn + p * c * c;
  const m12 = (s - p) * c * sn;
  return [m11, m12, m12, m22];
}

function mul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
  ];
}

// ---------- placeholder image ----------

function makePlaceholder() {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  const g = c.getContext('2d');
  g.fillStyle = '#ffd54f';
  g.beginPath(); g.arc(200, 200, 180, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#222';
  g.beginPath(); g.ellipse(140, 160, 22, 34, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(260, 160, 22, 34, 0, 0, Math.PI * 2); g.fill();
  g.lineWidth = 16; g.lineCap = 'round'; g.strokeStyle = '#222';
  g.beginPath(); g.arc(200, 220, 90, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
  g.fillStyle = '#222';
  g.font = 'bold 30px Impact, sans-serif';
  g.textAlign = 'center';
  g.fillText('DROP AN IMAGE', 200, 385);
  return c;
}

// ---------- display ----------

const display = document.getElementById('display');
const dctx = display.getContext('2d');

function resizeDisplay() {
  const dpr = window.devicePixelRatio || 1;
  const r = display.getBoundingClientRect();
  display.width = Math.max(1, Math.round(r.width * dpr));
  display.height = Math.max(1, Math.round(r.height * dpr));
}

function imgSize(img = state.img) {
  return { iw: img.naturalWidth || img.width, ih: img.naturalHeight || img.height };
}

function sceneMatrix(time) {
  let M = [1, 0, 0, 1];
  for (const axis of state.axes) {
    if (axis.enabled) M = mul(axisMatrix(axis, time), M);
  }
  return M;
}

// Draw the image centered in a W×H canvas at k canvas px per image px, transformed by M.
function renderScene(ctx, W, H, k, M) {
  const img = state.img;
  const { iw, ih } = imgSize();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!state.transparent) {
    ctx.fillStyle = state.bg;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.setTransform(M[0], M[1], M[2], M[3], W / 2, H / 2);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (-iw * k) / 2, (-ih * k) / 2, iw * k, ih * k);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawDisplay(time) {
  const W = display.width, H = display.height;
  const dpr = window.devicePixelRatio || 1;
  const { iw, ih } = imgSize();
  const cx = W / 2, cy = H / 2;

  if (state.cutting) {
    // Show the untransformed image large, so the lasso can be drawn on it.
    const k = Math.min((W * 0.9) / iw, (H * 0.9) / ih);
    state.view.k = k;
    renderScene(dctx, W, H, k, [1, 0, 0, 1]);
    dctx.strokeStyle = 'rgba(255,255,255,0.35)';
    dctx.setLineDash([4 * dpr, 4 * dpr]);
    dctx.lineWidth = 1 * dpr;
    dctx.strokeRect(cx - (iw * k) / 2, cy - (ih * k) / 2, iw * k, ih * k);
    dctx.setLineDash([]);
    drawLasso();
    return;
  }

  const k = Math.min((W * state.fit) / iw, (H * state.fit) / ih);
  state.view.k = k;
  renderScene(dctx, W, H, k, sceneMatrix(time));

  if (state.guides) {
    const len = Math.hypot(W, H);
    dctx.lineWidth = 1.5 * dpr;
    dctx.setLineDash([8 * dpr, 6 * dpr]);
    for (const axis of state.axes) {
      if (!axis.enabled) continue;
      const th = (-axis.angle * Math.PI) / 180;
      const dx = Math.cos(th) * len, dy = Math.sin(th) * len;
      dctx.strokeStyle = axis.color;
      dctx.globalAlpha = 0.7;
      dctx.beginPath();
      dctx.moveTo(cx - dx, cy - dy);
      dctx.lineTo(cx + dx, cy + dy);
      dctx.stroke();
    }
    dctx.globalAlpha = 1;
    dctx.setLineDash([]);
  }
}

// ---------- curve editor ----------

const PAD_Y = 14;

function curveGeom(canvas) {
  const W = canvas.width, H = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const pad = PAD_Y * dpr;
  return {
    W, H, dpr, pad,
    x: (t) => t * W,
    y: (v) => H / 2 - v * (H / 2 - pad),
    t: (px) => px / W,
    v: (py) => (H / 2 - py) / (H / 2 - pad),
  };
}

function drawCurve(axis, time) {
  const canvas = axis.ui.curve;
  const ctx = canvas.getContext('2d');
  const g = curveGeom(canvas);
  const { W, H, dpr } = g;

  ctx.clearRect(0, 0, W, H);

  // grid
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#2a2a3a';
  for (let i = 1; i < 4; i++) {
    const x = (W * i) / 4;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (const v of [1, -1, 0.5, -0.5]) {
    ctx.beginPath(); ctx.moveTo(0, g.y(v)); ctx.lineTo(W, g.y(v)); ctx.stroke();
  }
  ctx.strokeStyle = '#4a4a64';
  ctx.beginPath(); ctx.moveTo(0, g.y(0)); ctx.lineTo(W, g.y(0)); ctx.stroke();

  // labels
  ctx.fillStyle = '#7a7a94';
  ctx.font = `${10 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(`×${axis.mult.toFixed(2)} stretch`, 4 * dpr, 2 * dpr);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`×${(1 / axis.mult).toFixed(2)} compress`, 4 * dpr, H - 2 * dpr);
  ctx.textBaseline = 'middle';
  ctx.fillText('×1', 4 * dpr, g.y(0) - 7 * dpr);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${axis.duration.toFixed(2)}s`, W - 4 * dpr, H - 2 * dpr);
  ctx.textAlign = 'left';

  // curve
  ctx.strokeStyle = axis.color;
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  const steps = Math.max(100, Math.round(W / 2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const v = evalCurve(axis.pts, axis.interp, t >= 1 ? 0.999999 : t);
    const x = g.x(t), y = g.y(v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // points
  for (const p of axis.pts) {
    const active = p === axis.ui.drag || p === axis.ui.hover;
    ctx.fillStyle = active ? '#fff' : axis.color;
    ctx.strokeStyle = '#121219';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(g.x(p.t), g.y(p.v), (active ? 7 : 5) * dpr, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }

  // playhead
  if (axis.enabled) {
    const ph = axisPhase(axis, time);
    const x = g.x(ph);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    const v = evalCurve(axis.pts, axis.interp, ph);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x, g.y(v), 3 * dpr, 0, Math.PI * 2); ctx.fill();
  }
}

function resizeCurve(axis) {
  const dpr = window.devicePixelRatio || 1;
  const r = axis.ui.curve.getBoundingClientRect();
  axis.ui.curve.width = Math.max(1, Math.round(r.width * dpr));
  axis.ui.curve.height = Math.max(1, Math.round(r.height * dpr));
}

function pointerPos(canvas, e) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return { px: (e.clientX - r.left) * dpr, py: (e.clientY - r.top) * dpr };
}

function hitPoint(axis, px, py) {
  const g = curveGeom(axis.ui.curve);
  const R = 10 * g.dpr;
  let best = null, bestD = R;
  for (const p of axis.pts) {
    const d = Math.hypot(g.x(p.t) - px, g.y(p.v) - py);
    if (d <= bestD) { best = p; bestD = d; }
  }
  return best;
}

function setReadout(axis, p) {
  if (!p) { axis.ui.readout.textContent = ''; return; }
  const s = Math.pow(axis.mult, p.v);
  axis.ui.readout.textContent = `t = ${(p.t * axis.duration).toFixed(2)}s  ·  ×${s.toFixed(2)}`;
}

function attachCurveEditor(axis) {
  const canvas = axis.ui.curve;
  const clampT = (t) => Math.min(0.999, Math.max(0, t));
  const clampV = (v) => Math.min(1, Math.max(-1, v));

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const { px, py } = pointerPos(canvas, e);
    let p = hitPoint(axis, px, py);
    if (!p) {
      const g = curveGeom(canvas);
      p = { t: clampT(g.t(px)), v: clampV(g.v(py)) };
      axis.pts.push(p);
      axis.pts.sort((a, b) => a.t - b.t);
    }
    axis.ui.drag = p;
    canvas.setPointerCapture(e.pointerId);
    setReadout(axis, p);
  });

  canvas.addEventListener('pointermove', (e) => {
    const { px, py } = pointerPos(canvas, e);
    const p = axis.ui.drag;
    if (p) {
      const g = curveGeom(canvas);
      p.t = clampT(g.t(px));
      p.v = clampV(g.v(py));
      // Snap to the 0 line and the ±1 extremes when close.
      for (const snap of [0, 1, -1]) if (Math.abs(p.v - snap) < 0.04) p.v = snap;
      axis.pts.sort((a, b) => a.t - b.t);
      setReadout(axis, p);
    } else {
      axis.ui.hover = hitPoint(axis, px, py);
      setReadout(axis, axis.ui.hover);
    }
  });

  const endDrag = () => { axis.ui.drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (!axis.ui.drag) { axis.ui.hover = null; setReadout(axis, null); }
  });

  const removeAt = (e) => {
    const { px, py } = pointerPos(canvas, e);
    const p = hitPoint(axis, px, py);
    if (p && axis.pts.length > 1) {
      axis.pts.splice(axis.pts.indexOf(p), 1);
      axis.ui.hover = null;
      setReadout(axis, null);
    }
  };
  canvas.addEventListener('dblclick', removeAt);
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); removeAt(e); });
}

// ---------- axis UI ----------

const axisList = document.getElementById('axisList');
const axisTemplate = document.getElementById('axisTemplate');

function addAxis(opts = {}) {
  const id = nextAxisId++;
  const preset = opts.preset || 'sine';
  const axis = {
    id,
    color: AXIS_COLORS[(id - 1) % AXIS_COLORS.length],
    enabled: true,
    angle: opts.angle ?? 0,
    mult: opts.mult ?? 1.6,
    duration: opts.duration ?? 1,
    preserve: opts.preserve ?? false,
    interp: PRESETS[preset].interp,
    pts: makePoints(preset),
    ui: {},
  };

  const el = axisTemplate.content.firstElementChild.cloneNode(true);
  el.style.setProperty('--axis-color', axis.color);
  el.querySelector('.axis-name').textContent = `Axis ${id}`;
  axis.ui.el = el;
  axis.ui.curve = el.querySelector('canvas.curve');
  axis.ui.readout = el.querySelector('.readout');

  const inputs = el.querySelectorAll('[data-k]');
  const sync = () => {
    for (const inp of inputs) {
      const k = inp.dataset.k;
      if (k === 'preset') continue;
      if (inp.type === 'checkbox') inp.checked = axis[k];
      else inp.value = axis[k];
    }
    el.classList.toggle('disabled', !axis.enabled);
  };

  for (const inp of inputs) {
    const k = inp.dataset.k;
    const evt = inp.tagName === 'SELECT' || inp.type === 'checkbox' ? 'change' : 'input';
    inp.addEventListener(evt, () => {
      if (k === 'preset') {
        if (inp.value) {
          axis.pts = makePoints(inp.value);
          axis.interp = PRESETS[inp.value].interp;
          inp.value = '';
        }
      } else if (inp.type === 'checkbox') {
        axis[k] = inp.checked;
      } else if (inp.tagName === 'SELECT') {
        axis[k] = inp.value;
      } else {
        const n = parseFloat(inp.value);
        if (!Number.isFinite(n)) return;
        const min = parseFloat(inp.min), max = parseFloat(inp.max);
        axis[k] = Math.min(max, Math.max(min, n));
      }
      // Keep paired range/number inputs in sync without clobbering the one being typed in.
      for (const other of inputs) {
        if (other !== inp && other.dataset.k === k && other.type !== 'checkbox') other.value = axis[k];
      }
      el.classList.toggle('disabled', !axis.enabled);
    });
  }

  el.querySelectorAll('[data-angle]').forEach((btn) => {
    btn.addEventListener('click', () => { axis.angle = +btn.dataset.angle; sync(); });
  });

  el.querySelector('.del').addEventListener('click', () => {
    state.axes = state.axes.filter((a) => a !== axis);
    el.remove();
  });

  sync();
  axisList.appendChild(el);
  state.axes.push(axis);
  resizeCurve(axis);
  attachCurveEditor(axis);
  return axis;
}

// ---------- image loading ----------

const statusEl = document.getElementById('status');

function setStatus(msg) { statusEl.textContent = msg; }

function setImage(img, { fresh = false } = {}) {
  state.img = img;
  if (fresh) {
    state.original = img;
    state.history = [];
  }
  updateCutButtons();
}

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('That file is not an image.');
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    setImage(img, { fresh: true });
    setStatus(`Loaded ${file.name} (${img.naturalWidth}×${img.naturalHeight})`);
  };
  img.onerror = () => { URL.revokeObjectURL(url); setStatus('Could not read that image.'); };
  img.src = url;
}

document.getElementById('fileInput').addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) loadFile(file);
  else setStatus('Drop an image file (png, jpg, gif, webp…).');
});
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

// ---------- lasso cut ----------

const canvasWrap = document.getElementById('canvasWrap');
const cutBtn = document.getElementById('cutBtn');
const cutMode = document.getElementById('cutMode');
const undoCutBtn = document.getElementById('undoCutBtn');
const resetImgBtn = document.getElementById('resetImgBtn');
const CLOSE_DIST = 18; // CSS px: release this close to the start point to close the shape

function updateCutButtons() {
  undoCutBtn.disabled = state.history.length === 0;
  resetImgBtn.disabled = !state.original || state.img === state.original;
}

function setCutting(on) {
  state.cutting = on;
  state.lasso = null;
  cutBtn.classList.toggle('active', on);
  cutBtn.textContent = on ? '✓ Done cutting' : '✂ Lasso';
  canvasWrap.classList.toggle('cutting', on);
  setStatus(on
    ? 'Hold the left mouse button and draw around an area. Release on the green start point to close the shape and cut it.'
    : '');
}

cutBtn.addEventListener('click', () => setCutting(!state.cutting));

// Display px <-> image px while in cut mode (image drawn untransformed and centered).
function displayToImage(px, py) {
  const { iw, ih } = imgSize();
  const k = state.view.k;
  return { x: (px - display.width / 2) / k + iw / 2, y: (py - display.height / 2) / k + ih / 2 };
}
function imageToDisplay(x, y) {
  const { iw, ih } = imgSize();
  const k = state.view.k;
  return { px: (x - iw / 2) * k + display.width / 2, py: (y - ih / 2) * k + display.height / 2 };
}

function lassoCanClose() {
  const L = state.lasso;
  if (!L || L.pts.length < 3) return false;
  const dpr = window.devicePixelRatio || 1;
  const a = imageToDisplay(L.pts[0].x, L.pts[0].y);
  const b = imageToDisplay(L.pts[L.pts.length - 1].x, L.pts[L.pts.length - 1].y);
  // The path must also have travelled away from the start, so a tiny scribble doesn't count.
  let far = 0;
  for (const p of L.pts) {
    const d = imageToDisplay(p.x, p.y);
    far = Math.max(far, Math.hypot(d.px - a.px, d.py - a.py));
  }
  return Math.hypot(a.px - b.px, a.py - b.py) <= CLOSE_DIST * dpr && far > CLOSE_DIST * 2 * dpr;
}

function drawLasso() {
  const L = state.lasso;
  if (!L || !L.pts.length) return;
  const dpr = window.devicePixelRatio || 1;
  const closing = lassoCanClose();

  dctx.beginPath();
  L.pts.forEach((p, i) => {
    const d = imageToDisplay(p.x, p.y);
    if (i === 0) dctx.moveTo(d.px, d.py); else dctx.lineTo(d.px, d.py);
  });
  if (closing) {
    dctx.closePath();
    dctx.fillStyle = 'rgba(129, 199, 132, 0.25)';
    dctx.fill();
  }
  dctx.lineJoin = 'round';
  dctx.lineWidth = 4 * dpr;
  dctx.strokeStyle = 'rgba(0,0,0,0.7)';
  dctx.stroke();
  dctx.lineWidth = 2 * dpr;
  dctx.strokeStyle = closing ? '#81c784' : '#ff5fa2';
  dctx.stroke();

  const s = imageToDisplay(L.pts[0].x, L.pts[0].y);
  dctx.beginPath();
  dctx.arc(s.px, s.py, CLOSE_DIST * dpr, 0, Math.PI * 2);
  dctx.fillStyle = closing ? 'rgba(129, 199, 132, 0.45)' : 'rgba(129, 199, 132, 0.18)';
  dctx.fill();
  dctx.lineWidth = 2 * dpr;
  dctx.strokeStyle = '#81c784';
  dctx.stroke();
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(a / 2);
}

// Crop a canvas to the bounding box of its non-transparent pixels. Returns null if fully transparent.
function trimTransparent(canvas) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, -x0, -y0);
  return out;
}

function applyCut(pts, mode) {
  const { iw, ih } = imgSize();
  const c = document.createElement('canvas');
  c.width = iw;
  c.height = ih;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
  if (mode === 'keep') {
    g.save();
    g.clip();
    g.drawImage(state.img, 0, 0);
    g.restore();
  } else {
    g.drawImage(state.img, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    g.fill();
  }
  const trimmed = trimTransparent(c);
  if (!trimmed) {
    setStatus('Nothing would be left of the image, so the cut was not applied.');
    return;
  }
  state.history.push(state.img);
  setImage(trimmed);
  setStatus(`Cut applied (${mode === 'keep' ? 'kept inside' : 'removed inside'}). Draw another shape, or press "Done cutting". Tip: turn on the empty background for a clean cutout.`);
}

display.addEventListener('pointerdown', (e) => {
  if (!state.cutting || e.button !== 0) return;
  const { px, py } = pointerPos(display, e);
  state.lasso = { pts: [displayToImage(px, py)] };
  display.setPointerCapture(e.pointerId);
});

display.addEventListener('pointermove', (e) => {
  const L = state.lasso;
  if (!state.cutting || !L) return;
  const { px, py } = pointerPos(display, e);
  const last = imageToDisplay(L.pts[L.pts.length - 1].x, L.pts[L.pts.length - 1].y);
  if (Math.hypot(px - last.px, py - last.py) >= 2) L.pts.push(displayToImage(px, py));
});

display.addEventListener('pointerup', (e) => {
  const L = state.lasso;
  if (!state.cutting || !L || e.button !== 0) return;
  const closed = lassoCanClose();
  state.lasso = null;
  if (!closed) {
    setStatus('The shape was not closed, so nothing was cut. Release the mouse on the green start point to close it.');
    return;
  }
  if (polygonArea(L.pts) < 4) {
    setStatus('That shape is too small to cut.');
    return;
  }
  applyCut(L.pts, cutMode.value);
});

display.addEventListener('pointercancel', () => { state.lasso = null; });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.cutting) {
    if (state.lasso) state.lasso = null;
    else setCutting(false);
  }
});

undoCutBtn.addEventListener('click', () => {
  if (!state.history.length) return;
  setImage(state.history.pop());
  setStatus('Undid the last change to the image.');
});

resetImgBtn.addEventListener('click', () => {
  if (!state.original || state.img === state.original) return;
  state.history.push(state.img);
  setImage(state.original);
  setStatus('Image reset to the original (you can undo this).');
});

// ---------- global controls ----------

const playBtn = document.getElementById('playBtn');
playBtn.addEventListener('click', () => {
  if (state.playing) {
    state.pausedAt = performance.now() - state.clockStart;
    state.playing = false;
    playBtn.textContent = 'Play';
  } else {
    state.clockStart = performance.now() - state.pausedAt;
    state.playing = true;
    playBtn.textContent = 'Pause';
  }
});

function restartClock() {
  state.clockStart = performance.now();
  state.pausedAt = 0;
}
document.getElementById('restartBtn').addEventListener('click', restartClock);

document.getElementById('addAxis').addEventListener('click', () => {
  // Default new axes to a direction not already in use.
  const used = new Set(state.axes.map((a) => a.angle));
  const angle = [0, 90, 45, 135].find((a) => !used.has(a)) ?? 0;
  addAxis({ angle });
});

document.getElementById('fitInput').addEventListener('input', (e) => { state.fit = +e.target.value; });
document.getElementById('bgInput').addEventListener('input', (e) => { state.bg = e.target.value; });
document.getElementById('transparentInput').addEventListener('change', (e) => {
  state.transparent = e.target.checked;
  canvasWrap.classList.toggle('transparent', state.transparent);
});
document.getElementById('guidesInput').addEventListener('change', (e) => { state.guides = e.target.checked; });

// ---------- export ----------

const formatSelect = document.getElementById('formatSelect');
const sizeSelect = document.getElementById('sizeSelect');
const fpsSelect = document.getElementById('fpsSelect');
const lenInput = document.getElementById('lenInput');
const autoLenInput = document.getElementById('autoLenInput');
const exportBtn = document.getElementById('exportBtn');

const VIDEO_FORMATS = [
  { id: 'mp4', label: 'MP4 video', ext: 'mp4', mimes: ['video/mp4;codecs=avc1.42E01F', 'video/mp4;codecs=avc1', 'video/mp4'] },
  { id: 'webm-vp9', label: 'WebM video (VP9)', ext: 'webm', mimes: ['video/webm;codecs=vp9'] },
  { id: 'webm-vp8', label: 'WebM video (VP8)', ext: 'webm', mimes: ['video/webm;codecs=vp8', 'video/webm'] },
];

const FORMATS = [{ id: 'gif', label: 'GIF', ext: 'gif' }];
if (window.MediaRecorder && HTMLCanvasElement.prototype.captureStream) {
  for (const f of VIDEO_FORMATS) {
    const mime = f.mimes.find((m) => MediaRecorder.isTypeSupported(m));
    if (mime) FORMATS.push({ ...f, mime });
  }
}
for (const f of FORMATS) formatSelect.add(new Option(f.label, f.id));

autoLenInput.addEventListener('change', () => { lenInput.disabled = autoLenInput.checked; });

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// Length of one seamless loop of all enabled axes (LCM of their durations), capped at 30s.
function loopLength() {
  const ds = state.axes.filter((a) => a.enabled).map((a) => Math.max(1, Math.round(a.duration * 100)));
  if (!ds.length) return { seconds: 1, seamless: true };
  let l = ds[0];
  for (const d of ds.slice(1)) {
    l = (l / gcd(l, d)) * d;
    if (l > 3000) return { seconds: Math.max(...ds) / 100, seamless: false };
  }
  return { seconds: l / 100, seamless: true };
}

function exportSeconds() {
  if (autoLenInput.checked) return loopLength().seconds;
  return Math.min(60, Math.max(0.1, parseFloat(lenInput.value) || 1));
}

// Output size: the bounding box of the stretched image over the given times, scaled so its
// longer side is maxDim. Dimensions are even so video encoders accept them.
function exportLayout(times, maxDim) {
  const { iw, ih } = imgSize();
  let hx = 0, hy = 0;
  for (const t of times) {
    const M = sceneMatrix(t);
    for (const [x, y] of [[iw / 2, ih / 2], [iw / 2, -ih / 2]]) {
      hx = Math.max(hx, Math.abs(M[0] * x + M[2] * y));
      hy = Math.max(hy, Math.abs(M[1] * x + M[3] * y));
    }
  }
  const k = maxDim / Math.max(2 * hx, 2 * hy);
  const even = (v) => Math.max(2, Math.ceil(v / 2) * 2);
  return { W: even(2 * hx * k), H: even(2 * hy * k), k };
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

async function renderGif({ seconds, fps, maxDim, onProgress = () => {} }) {
  const delay = Math.max(2, Math.round(100 / fps)); // GIF delays are in 1/100 s
  const frames = Math.max(1, Math.round((seconds * 100) / delay));
  const times = Array.from({ length: frames }, (_, i) => (i * delay) / 100);
  const { W, H, k } = exportLayout(times, maxDim);

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const grab = (t) => {
    renderScene(ctx, W, H, k, sceneMatrix(t));
    return ctx.getImageData(0, 0, W, H).data;
  };

  // Every frame shows the same image (just stretched), so a few frames are enough for the palette.
  const sampleCount = Math.min(6, frames);
  const samples = [];
  for (let i = 0; i < sampleCount; i++) samples.push(grab(times[Math.floor((i * frames) / sampleCount)]));
  const palette = GIF.buildPalette(samples, state.transparent ? 255 : 256);
  const enc = new GIF.GifEncoder(W, H, palette, { transparent: state.transparent });

  for (let i = 0; i < frames; i++) {
    enc.addFrame(grab(times[i]), delay);
    if (i % 3 === 0) { onProgress(i, frames); await nextTick(); }
  }
  return { blob: new Blob([enc.finish()], { type: 'image/gif' }), W, H, frames };
}

function recordVideo({ format, seconds, fps, maxDim }) {
  return new Promise((resolve, reject) => {
    const times = Array.from({ length: Math.ceil(seconds * 60) + 1 }, (_, i) => i / 60);
    const { W, H, k } = exportLayout(times, maxDim);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    renderScene(ctx, W, H, k, sceneMatrix(0));

    const stream = c.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => { state.videoRec = null; reject(e.error || new Error('Recording failed')); };
    rec.onstop = () => {
      state.videoRec = null;
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: format.mime });
      // Some encoders (notably H.264) occasionally produce nothing on a very short first recording.
      if (!blob.size) reject(new Error('the browser produced an empty video. Please try again, or pick another format.'));
      else resolve({ blob, W, H });
    };
    // The main loop draws into this canvas every frame while recording.
    state.videoRec = { ctx, W, H, k, start: performance.now() };
    rec.start(250);
    setTimeout(() => rec.stop(), seconds * 1000);
  });
}

exportBtn.addEventListener('click', async () => {
  if (state.exporting) return;
  const format = FORMATS.find((f) => f.id === formatSelect.value);
  const seconds = exportSeconds();
  const loop = loopLength();
  const fps = +fpsSelect.value;
  const maxDim = +sizeSelect.value;
  if (state.cutting) setCutting(false);

  state.exporting = true;
  exportBtn.disabled = true;
  try {
    let msg;
    if (format.id === 'gif') {
      exportBtn.textContent = 'Rendering…';
      const res = await renderGif({
        seconds, fps, maxDim,
        onProgress: (i, n) => setStatus(`Rendering GIF: frame ${i + 1} of ${n}…`),
      });
      download(res.blob, 'stretched.gif');
      const kb = Math.round(res.blob.size / 1024);
      msg = `Exported GIF: ${res.W}×${res.H}, ${res.frames} frames, ${kb} KB.`;
      if (kb > 10240) msg += " That's over Discord's 10 MB limit; try a smaller size or lower FPS.";
    } else {
      exportBtn.textContent = 'Recording…';
      setStatus(`Recording ${seconds.toFixed(2)}s of video…`);
      const res = await recordVideo({ format, seconds, fps, maxDim });
      download(res.blob, `stretched.${format.ext}`);
      msg = `Exported ${format.label}: ${res.W}×${res.H}, ${seconds.toFixed(2)}s.`;
      if (state.transparent) msg += ' Most video players show the empty background as black; use GIF to keep it transparent.';
    }
    if (autoLenInput.checked && !loop.seamless) {
      msg += " The axis durations don't line up within 30s, so the loop isn't perfectly seamless.";
    }
    setStatus(msg);
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${err.message || err}`);
  } finally {
    state.exporting = false;
    exportBtn.disabled = false;
    exportBtn.textContent = 'Export';
  }
});

// ---------- main loop ----------

function frame() {
  const time = currentTime();
  drawDisplay(time);
  for (const axis of state.axes) drawCurve(axis, time);

  const rec = state.videoRec;
  if (rec) {
    const t = (performance.now() - rec.start) / 1000;
    renderScene(rec.ctx, rec.W, rec.H, rec.k, sceneMatrix(t));
  }
  if (autoLenInput.checked) {
    const s = loopLength().seconds.toFixed(2);
    if (lenInput.value !== s) lenInput.value = s;
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  resizeDisplay();
  state.axes.forEach(resizeCurve);
});

setImage(makePlaceholder());
addAxis({ angle: 0, mult: 1.6, duration: 1, preset: 'sine' });
resizeDisplay();
requestAnimationFrame(frame);
