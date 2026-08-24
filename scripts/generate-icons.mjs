// Einmal-Skript: erzeugt die PWA-Icons (PNG) ohne externe Abhängigkeiten.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Projekt-Root = Elternerzeichnis dieses Skripts (scripts/..)
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'public');
mkdirSync(outDir, { recursive: true });

// --- CRC32 (für PNG-Chunks) -------------------------------------------------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// --- Zeichen "M" als geometrische Abfrage (normierte Koordinaten 0..1) ------
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const BG = [79, 70, 229]; // #4f46e5
const FG = [255, 255, 255];

function isM(x, y) {
  // Stiele
  if (x >= 0.26 && x <= 0.39 && y >= 0.24 && y <= 0.76) return true;
  if (x >= 0.61 && x <= 0.74 && y >= 0.24 && y <= 0.76) return true;
  // Diagonalen nach unten in die Mitte
  const half = 0.065;
  if (distToSegment(x, y, 0.26, 0.24, 0.5, 0.56) <= half) return true;
  if (distToSegment(x, y, 0.74, 0.24, 0.5, 0.56) <= half) return true;
  return false;
}

// --- PNG-Encoder (8-bit RGBA) ----------------------------------------------
function makePng(size, pixelFn) {
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // Filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // Bit-Tiefe
  ihdr[9] = 6; // Farbtyp: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function iconPixel(size) {
  return (x, y) => {
    const nx = (x + 0.5) / size;
    const ny = (y + 0.5) / size;
    const c = isM(nx, ny) ? FG : BG;
    return [c[0], c[1], c[2], 255];
  };
}

const targets = [
  ['apple-touch-icon.png', 180],
  ['pwa-192x192.png', 192],
  ['pwa-512x512.png', 512],
];
for (const [name, size] of targets) {
  writeFileSync(join(outDir, name), makePng(size, iconPixel(size)));
  console.log(`public/${name} (${size}x${size})`);
}

// favicon.ico: PNG-Bytefolge (wird von allen modernen Browsern akzeptiert)
writeFileSync(join(outDir, 'favicon.ico'), makePng(64, iconPixel(64)));
console.log('public/favicon.ico (64x64, PNG-in-ICO)');
