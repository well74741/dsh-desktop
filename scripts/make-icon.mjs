/**
 * Generates DSH Studio icons with zero dependencies — plain Node zlib + a
 * hand-rolled PNG encoder, plus a Vista+ ICO container holding PNG-compressed
 * entries (16/32/48/256).
 *
 * Outputs:
 *   assets/icon.png    32x32   (tray / runtime quick icons)
 *   assets/icon-256.png 256x256 (window/installer fallback)
 *   assets/icon.ico    16/32/48/256 (NSIS / exe icon)
 *
 * Replace with a real brand asset later; keeps packaging working from day one.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));

// ---- CRC32 ----
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	CRC_TABLE[n] = c >>> 0;
}
function crc32(bytes) {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const typeBytes = Buffer.from(type, "ascii");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
	return Buffer.concat([len, typeBytes, data, crc]);
}

/** Per-pixel shader: rounded square, brighter blue-violet gradient, white notch. */
function pixelColor(size, x, y) {
	const margin = size * 0.09;
	const radius = size * 0.24;
	const inside = x >= margin && x < size - margin && y >= margin && y < size - margin;
	let corner = false;
	if (inside) {
		const dx = (cx) => (x - cx) ** 2;
		const dy = (cy) => (y - cy) ** 2;
		const r2 = radius ** 2;
		const m = margin + radius;
		const s = size - margin - radius;
		corner =
			(x < m && y < m && dx(m) + dy(m) > r2) ||
			(x >= s && y < m && dx(s) + dy(m) > r2) ||
			(x < m && y >= s && dx(m) + dy(s) > r2) ||
			(x >= s && y >= s && dx(s) + dy(s) > r2);
	}
	if (!inside || corner) return [0, 0, 0, 0];
	const t = (x + y) / (2 * size);
	const r = Math.round(72 + 26 * t);
	const g = Math.round(118 + 22 * t);
	const b = Math.round(250 - 40 * (1 - t));
	// White bottom-right notch gives a visible "D" hint at 16 px.
	const notch = x > size * 0.56 && y > size * 0.56;
	return notch ? [255, 255, 255, 255] : [r, g, b, 255];
}

function encodePng(size) {
	const raw = Buffer.alloc(size * (1 + size * 4));
	for (let y = 0; y < size; y++) {
		const rowStart = y * (1 + size * 4);
		raw[rowStart] = 0; // filter: none
		for (let x = 0; x < size; x++) {
			const [r, g, b, a] = pixelColor(size, x, y);
			const p = rowStart + 1 + x * 4;
			raw[p] = r;
			raw[p + 1] = g;
			raw[p + 2] = b;
			raw[p + 3] = a;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;
	ihdr[9] = 6; // RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0))
	]);
}

function encodeIco(sizes) {
	const images = sizes.map((size) => ({ size, data: encodePng(size) }));
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(images.length, 4);
	const entries = Buffer.alloc(images.length * 16);
	let offset = 6 + entries.length;
	images.forEach((image, i) => {
		const e = entries.subarray(i * 16, (i + 1) * 16);
		e[0] = image.size >= 256 ? 0 : image.size;
		e[1] = image.size >= 256 ? 0 : image.size;
		e[2] = 0;
		e[3] = 0;
		e.writeUInt16LE(1, 4); // color planes
		e.writeUInt16LE(32, 6); // bpp
		e.writeUInt32LE(image.data.length, 8);
		e.writeUInt32LE(offset, 12);
		offset += image.data.length;
	});
	return Buffer.concat([header, entries, ...images.map((i) => i.data)]);
}

mkdirSync(ASSETS, { recursive: true });
const icon32 = encodePng(32);
const icon256 = encodePng(256);
const tray16 = encodePng(16);
const tray32 = encodePng(32);
const ico = encodeIco([16, 32, 48, 256]);

writeFileSync(join(ASSETS, "icon.png"), icon32);
writeFileSync(join(ASSETS, "icon-256.png"), icon256);
writeFileSync(join(ASSETS, "tray-16.png"), tray16);
writeFileSync(join(ASSETS, "tray-32.png"), tray32);
writeFileSync(join(ASSETS, "icon.ico"), ico);
console.log(`wrote icon.png (${icon32.length}B), icon-256.png (${icon256.length}B), tray-16.png (${tray16.length}B), tray-32.png (${tray32.length}B), icon.ico (${ico.length}B)`);
