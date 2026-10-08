// Minimal animated GIF89a encoder: median-cut global palette, LZW compression,
// optional 1-bit transparency, infinite looping. Exposes window.GIF.
(function () {
  class ByteWriter {
    constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; }
    ensure(n) {
      if (this.len + n <= this.buf.length) return;
      const nb = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
    byte(b) { this.ensure(1); this.buf[this.len++] = b; }
    u16(v) { this.byte(v & 255); this.byte((v >> 8) & 255); }
    bytes(a) { this.ensure(a.length); this.buf.set(a, this.len); this.len += a.length; }
    str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
    result() { return this.buf.slice(0, this.len); }
  }

  // Build a palette of up to maxColors from RGBA sample frames (pixels with alpha < 128 are ignored).
  function buildPalette(samples, maxColors) {
    let total = 0;
    for (const s of samples) total += s.length / 4;
    const step = Math.max(1, Math.floor(total / 80000));
    const px = [];
    let n = 0;
    for (const s of samples) {
      for (let i = 0; i < s.length; i += 4) {
        if (n++ % step !== 0 || s[i + 3] < 128) continue;
        px.push((s[i] << 16) | (s[i + 1] << 8) | s[i + 2]);
      }
    }
    if (!px.length) px.push(0);
    const arr = Int32Array.from(px);
    const chan = (v, c) => (v >> (16 - 8 * c)) & 255;

    const stats = (b) => {
      const mn = [255, 255, 255], mx = [0, 0, 0];
      for (let i = b.lo; i < b.hi; i++) {
        for (let c = 0; c < 3; c++) {
          const x = chan(arr[i], c);
          if (x < mn[c]) mn[c] = x;
          if (x > mx[c]) mx[c] = x;
        }
      }
      let ch = 0;
      for (let c = 1; c < 3; c++) if (mx[c] - mn[c] > mx[ch] - mn[ch]) ch = c;
      return { ch, range: mx[ch] - mn[ch] };
    };

    const boxes = [{ lo: 0, hi: arr.length }];
    while (boxes.length < maxColors) {
      let best = -1, bestScore = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.hi - b.lo < 2) continue;
        if (!b.st) b.st = stats(b);
        const score = b.st.range * (b.hi - b.lo);
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) break;
      const b = boxes[best];
      const c = b.st.ch;
      arr.subarray(b.lo, b.hi).sort((x, y) => chan(x, c) - chan(y, c));
      const mid = b.lo + ((b.hi - b.lo) >> 1);
      boxes.splice(best, 1, { lo: b.lo, hi: mid }, { lo: mid, hi: b.hi });
    }

    return boxes.map((b) => {
      let r = 0, g = 0, bl = 0;
      for (let i = b.lo; i < b.hi; i++) { r += chan(arr[i], 0); g += chan(arr[i], 1); bl += chan(arr[i], 2); }
      const k = Math.max(1, b.hi - b.lo);
      return [Math.round(r / k), Math.round(g / k), Math.round(bl / k)];
    });
  }

  class GifEncoder {
    // palette: array of [r,g,b], at most 255 entries if transparent, else 256.
    constructor(width, height, palette, { transparent = false, loop = 0 } = {}) {
      this.w = width;
      this.h = height;
      this.palette = palette;
      this.transparent = transparent;
      this.transIndex = transparent ? palette.length : 0;
      const colors = palette.length + (transparent ? 1 : 0);
      let bits = 1;
      while ((1 << bits) < colors) bits++;
      this.bits = bits;
      this.minCodeSize = Math.max(2, bits);
      this.cache = new Int16Array(32768).fill(-1);
      this.indices = new Uint8Array(width * height);
      this.stamp = new Int32Array(4096 << 8);
      this.code = new Int16Array(4096 << 8);
      this.gen = 0;

      const out = (this.out = new ByteWriter());
      out.str('GIF89a');
      out.u16(width);
      out.u16(height);
      out.byte(0x80 | ((bits - 1) << 4) | (bits - 1));
      out.byte(0);
      out.byte(0);
      for (let i = 0; i < 1 << bits; i++) {
        const c = palette[i] || [0, 0, 0];
        out.byte(c[0]); out.byte(c[1]); out.byte(c[2]);
      }
      // NETSCAPE2.0 looping extension
      out.byte(0x21); out.byte(0xff); out.byte(0x0b);
      out.str('NETSCAPE2.0');
      out.byte(0x03); out.byte(0x01); out.u16(loop); out.byte(0x00);
    }

    nearest(r, g, b) {
      let best = 0, bd = Infinity;
      const p = this.palette;
      for (let i = 0; i < p.length; i++) {
        const dr = p[i][0] - r, dg = p[i][1] - g, db = p[i][2] - b;
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }

    addFrame(rgba, delayCs) {
      const { w, h, out, cache, indices } = this;
      const n = w * h;
      for (let p = 0, i = 0; p < n; p++, i += 4) {
        if (this.transparent && rgba[i + 3] < 128) { indices[p] = this.transIndex; continue; }
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let v = cache[key];
        if (v < 0) { v = this.nearest(r, g, b); cache[key] = v; }
        indices[p] = v;
      }

      // Graphic control extension: disposal 2 (restore to background) so transparent areas stay clear.
      out.byte(0x21); out.byte(0xf9); out.byte(0x04);
      out.byte(((this.transparent ? 2 : 1) << 2) | (this.transparent ? 1 : 0));
      out.u16(delayCs);
      out.byte(this.transIndex);
      out.byte(0x00);
      // Image descriptor
      out.byte(0x2c);
      out.u16(0); out.u16(0); out.u16(w); out.u16(h);
      out.byte(0x00);
      this.writeLZW(indices);
    }

    writeLZW(indices) {
      const out = this.out;
      const minCodeSize = this.minCodeSize;
      out.byte(minCodeSize);

      const block = new Uint8Array(255);
      let blen = 0;
      const pushByte = (b) => {
        block[blen++] = b;
        if (blen === 255) { out.byte(255); out.bytes(block); blen = 0; }
      };

      const clear = 1 << minCodeSize, eoi = clear + 1;
      let codeSize = minCodeSize + 1;
      let next = eoi + 1;
      let bitBuf = 0, bitCnt = 0;
      const emit = (c) => {
        bitBuf |= c << bitCnt;
        bitCnt += codeSize;
        while (bitCnt >= 8) { pushByte(bitBuf & 255); bitBuf >>>= 8; bitCnt -= 8; }
      };

      const { stamp, code } = this;
      let gen = ++this.gen;
      emit(clear);
      let prefix = indices[0];
      for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = (prefix << 8) | k;
        if (stamp[key] === gen) { prefix = code[key]; continue; }
        emit(prefix);
        if (next === 4096) {
          emit(clear);
          next = eoi + 1;
          codeSize = minCodeSize + 1;
          gen = ++this.gen;
        } else {
          if (next >= 1 << codeSize) codeSize++;
          stamp[key] = gen;
          code[key] = next++;
        }
        prefix = k;
      }
      emit(prefix);
      emit(eoi);
      if (bitCnt > 0) pushByte(bitBuf & 255);
      if (blen) { out.byte(blen); out.bytes(block.subarray(0, blen)); }
      out.byte(0x00);
    }

    finish() {
      this.out.byte(0x3b);
      return this.out.result();
    }
  }

  window.GIF = { buildPalette, GifEncoder };
})();
