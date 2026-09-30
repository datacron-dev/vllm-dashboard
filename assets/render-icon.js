'use strict';
// Renders the vLLM-Playground "V" mark (two triangles) from its SVG path data
// into a 512x512 RGBA PNG. No dependencies beyond Node's zlib + fs.
//
// SVG (viewBox 0 0 24 24):
//   path1: M0 4.973 h9.324 V23 L0 4.973 z   fill #FDB515 (amber)
//   path2: M13.986 4.351 L22.378 0 l-6.216 23 H9.324 l4.662-18.649z fill #30A2FF (blue)
//
// We rasterize at 512x512 (scale = 512/24) with 2x supersampling for smooth
// anti-aliased edges.

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const N = 512;          // output size
const SS = 2;          // supersampling factor
const SCALE = N / 24;  // SVG unit -> px

function hexToRgb(h) {
  h = h.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
const AMBER = hexToRgb('#FDB515');
const BLUE  = hexToRgb('#30A2FF');

// Build polygon vertex lists (in px space) from the SVG path commands.
function buildPolygons() {
  // path1: M0,4.973 -> h9.324 -> V23 -> L0,4.973
  const p1 = [
    [0, 4.973],
    [9.324, 4.973],
    [9.324, 23],
  ];
  // path2: M13.986,4.351 -> L22.378,0 -> l-6.216,23 -> H9.324 -> l4.662,-18.649
  const p2 = [
    [13.986, 4.351],
    [22.378, 0],
    [22.378 - 6.216, 23],   // 16.162, 23
    [9.324, 23],
  ];
  return [p1.map(([x,y]) => [x*SCALE, y*SCALE]),
          p2.map(([x,y]) => [x*SCALE, y*SCALE])];
}

// Point-in-polygon (even-odd / ray casting).
function insidePoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersects = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

const polys = buildPolygons();
const [amber, blue] = polys;

// Accumulate color over the SS grid.
const acc = new Float32Array(N * N * 4); // R,G,B,A
for (let py = 0; py < N; py++) {
  for (let px = 0; px < N; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) * 1; // in px space
        const y = (py + (sy + 0.5) / SS) * 1;
        // Test blue first (drawn on top per SVG order: amber then blue)
        let hit = null;
        if (insidePoly(x, y, blue)) hit = BLUE;
        else if (insidePoly(x, y, amber)) hit = AMBER;
        if (hit) { r += hit[0]; g += hit[1]; b += hit[2]; a += 255; }
      }
    }
    const o = (py * N + px) * 4;
    const n = SS * SS;
    if (a > 0) {
      acc[o]   = r / n;
      acc[o+1] = g / n;
      acc[o+2] = b / n;
      acc[o+3] = 255 * (a / n);
    } else {
      acc[o] = 0; acc[o+1] = 0; acc[o+2] = 0; acc[o+3] = 0;
    }
  }
}

// Build PNG (RGBA, filter 0 per row).
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0; // filter byte
  for (let x = 0; x < N; x++) {
    const src = (y * N + x) * 4;
    const dst = y * (N * 4 + 1) + 1 + x * 4;
    raw[dst]   = Math.round(acc[src]);
    raw[dst+1] = Math.round(acc[src+1]);
    raw[dst+2] = Math.round(acc[src+2]);
    raw[dst+3] = Math.round(acc[src+3]);
  }
}
const idat = zlib.deflateSync(raw, { level: 9 });

// CRC32 table
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
const sig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
