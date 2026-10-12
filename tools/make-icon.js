/**
 * Generates build/icon.ico and src/assets/icon.ico from scratch.
 *
 * No image libraries: shapes are rasterised with 4x supersampling, encoded as
 * raw PNG chunks (zlib is built in) and packed into a multi-resolution ICO.
 * Run with `npm run icon`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 4;

// Matches --accent in the renderer stylesheet.
const GRAD_TOP = [0x5e, 0xea, 0x8d];
const GRAD_BOTTOM = [0x16, 0xa3, 0x4a];
const MARK = [0xff, 0xff, 0xff];

/* ---------------------------------------------------------------- geometry */

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Checkmark spine in 0..1 space, with a round-capped stroke. */
const CHECK = [
  [0.255, 0.525],
  [0.425, 0.695],
  [0.755, 0.325],
];
const CHECK_WIDTH = 0.118;

function onCheck(nx, ny, halfWidth) {
  for (let i = 0; i < CHECK.length - 1; i++) {
    const [ax, ay] = CHECK[i];
    const [bx, by] = CHECK[i + 1];
    if (distanceToSegment(nx, ny, ax, ay, bx, by) <= halfWidth) return true;
  }
  return false;
}

/* --------------------------------------------------------------- rasteriser */

function renderRGBA(size) {
  const out = Buffer.alloc(size * size * 4);
  const n = SUPERSAMPLE * SUPERSAMPLE;
  const step = 1 / SUPERSAMPLE;

  // Thin strokes vanish at 16px, so fatten the mark slightly on small icons.
  const halfWidth = (CHECK_WIDTH * (size <= 24 ? 1.22 : 1)) / 2;
  const pad = size <= 24 ? 0.0 : 0.045;
  const radius = 0.225 - pad;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sumA = 0;
      let r = 0;
      let g = 0;
      let b = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const nx = (x + (sx + 0.5) * step) / size;
          const ny = (y + (sy + 0.5) * step) / size;
          if (!inRoundedRect(nx, ny, pad, pad, 1 - pad, 1 - pad, radius)) continue;

          sumA++;
          if (onCheck(nx, ny, halfWidth)) {
            r += MARK[0];
            g += MARK[1];
            b += MARK[2];
          } else {
            const t = (ny - pad) / (1 - 2 * pad);
            r += GRAD_TOP[0] + (GRAD_BOTTOM[0] - GRAD_TOP[0]) * t;
            g += GRAD_TOP[1] + (GRAD_BOTTOM[1] - GRAD_TOP[1]) * t;
            b += GRAD_TOP[2] + (GRAD_BOTTOM[2] - GRAD_TOP[2]) * t;
          }
        }
      }

      const i = (y * size + x) * 4;
      if (sumA === 0) continue;
      out[i] = Math.round(r / sumA);
      out[i + 1] = Math.round(g / sumA);
      out[i + 2] = Math.round(b / sumA);
      out[i + 3] = Math.round((sumA / n) * 255);
    }
  }
  return out;
}

/* -------------------------------------------------------------- PNG encoder */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- ICO packer */

function packICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((img, i) => {
    const e = i * 16;
    directory[e] = img.size >= 256 ? 0 : img.size; // 0 means 256
    directory[e + 1] = img.size >= 256 ? 0 : img.size;
    directory[e + 2] = 0; // palette size
    directory[e + 3] = 0; // reserved
    directory.writeUInt16LE(1, e + 4); // colour planes
    directory.writeUInt16LE(32, e + 6); // bits per pixel
    directory.writeUInt32BE(0, e + 8);
    directory.writeUInt32LE(img.png.length, e + 8);
    directory.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

/* -------------------------------------------------------------------- main */

const images = SIZES.map((size) => ({ size, png: encodePNG(renderRGBA(size), size) }));
const ico = packICO(images);

const targets = [
  path.join(__dirname, '..', 'build', 'icon.ico'),
  path.join(__dirname, '..', 'src', 'assets', 'icon.ico'),
];

for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, ico);
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), target)} (${ico.length} bytes)`);
}

// A lone 256px PNG is handy for previewing the result.
fs.writeFileSync(
  path.join(__dirname, '..', 'build', 'icon-preview.png'),
  images[images.length - 1].png
);
console.log('wrote build/icon-preview.png');
