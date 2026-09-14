import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const count = 9000;
const buffer = Buffer.alloc(count * 32);

let seed = 0x1a2b3c4d;
const random = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};

for (let i = 0; i < count; i++) {
  const offset = i * 32;
  const arm = i % 3;
  const alongArm = Math.floor(i / 3) / Math.ceil(count / 3);
  const radius = 0.2 + 2.2 * Math.pow(alongArm, .72) + (random() - .5) * .09;
  const angle = arm * Math.PI * 2 / 3 + radius * 2.55 + (random() - .5) * .32;
  const x = Math.cos(angle) * radius + (random() - .5) * .16;
  const y = Math.sin(angle) * radius + (random() - .5) * .16;
  const z = (random() - .5) * (.12 + radius * .16);
  const scale = .004 + random() * .009 + radius * .001;
  buffer.writeFloatLE(x, offset);
  buffer.writeFloatLE(y, offset + 4);
  buffer.writeFloatLE(z, offset + 8);
  buffer.writeFloatLE(scale * (1.4 + random()), offset + 12);
  buffer.writeFloatLE(scale * (.7 + random() * .5), offset + 16);
  buffer.writeFloatLE(scale * (1.4 + random()), offset + 20);
  const glow = Math.max(0, 1 - radius / 2.6);
  buffer[offset + 24] = Math.round(78 + glow * 91 + random() * 22);
  buffer[offset + 25] = Math.round(135 + glow * 92 + random() * 20);
  buffer[offset + 26] = Math.round(153 + glow * 89 + random() * 15);
  buffer[offset + 27] = Math.round(72 + glow * 130);
  buffer[offset + 28] = 255;
  buffer[offset + 29] = 128;
  buffer[offset + 30] = 128;
  buffer[offset + 31] = 128;
}

await mkdir(root, { recursive: true });
await mkdir(resolve(root, 'public'), { recursive: true });
const demoPath = resolve(root, 'public/demo.splat');
await writeFile(demoPath, buffer);

// A small binary INRIA-style PLY fixture exercises the second input path in browser tests.
const plyCount = 1200;
const properties = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const header = Buffer.from([
  'ply', 'format binary_little_endian 1.0', `element vertex ${plyCount}`,
  ...properties.map((name) => `property float ${name}`), 'end_header', ''
].join('\n'));
const plyBody = Buffer.alloc(plyCount * properties.length * 4);
for (let i = 0; i < plyCount; i++) {
  const sourceOffset = Math.floor(i * count / plyCount) * 32;
  const targetOffset = i * properties.length * 4;
  const x = buffer.readFloatLE(sourceOffset);
  const y = buffer.readFloatLE(sourceOffset + 4);
  const z = buffer.readFloatLE(sourceOffset + 8);
  const r = buffer[sourceOffset + 24] / 255;
  const g = buffer[sourceOffset + 25] / 255;
  const b = buffer[sourceOffset + 26] / 255;
  const values = [x, y, z, 0, 0, 0, (r - .5) / .28209479, (g - .5) / .28209479, (b - .5) / .28209479, 2.2, -4.45, -4.55, -4.45, 1, 0, 0, 0];
  values.forEach((value, index) => plyBody.writeFloatLE(value, targetOffset + index * 4));
}
await mkdir(resolve(root, 'tests'), { recursive: true });
await writeFile(resolve(root, 'tests/test-gaussian.ply'), Buffer.concat([header, plyBody]));

// Generate a KSPLAT fixture through the same public conversion primitives used by the project.
const splatData = await readFile(demoPath);
const splatArrayBuffer = splatData.buffer.slice(splatData.byteOffset, splatData.byteOffset + splatData.byteLength);
const splatArray = GaussianSplats3D.SplatParser.parseStandardSplatToUncompressedSplatArray(splatArrayBuffer);
const ksplat = GaussianSplats3D.SplatBufferGenerator.getStandardGenerator(5, 1, 0).generateFromUncompressedSplatArray(splatArray);
await writeFile(resolve(root, 'tests/test-gaussian.ksplat'), Buffer.from(ksplat.bufferData));
console.log(`Generated demo.splat (${count.toLocaleString()} splats) and PLY/KSPLAT test fixtures`);
