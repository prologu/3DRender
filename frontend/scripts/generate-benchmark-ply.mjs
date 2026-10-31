import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(frontendRoot, 'tests/generated');
const requested = process.argv.slice(2).map(Number).filter(value => Number.isInteger(value) && value > 0);
const counts = requested.length ? requested : [100_000, 500_000, 1_000_000];
const properties = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

let seed = 0x3d5a7c91;
function random() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}

function vertexValues(index, count) {
  // A deterministic city-like volume is more representative than duplicating one
  // point: it exercises projection, depth sorting and broad screen coverage.
  const side = Math.ceil(Math.sqrt(count / 12));
  const building = Math.floor(index / 12);
  const local = index % 12;
  const gx = building % side;
  const gz = Math.floor(building / side);
  const x0 = (gx - side / 2) * 0.075;
  const z0 = (gz - side / 2) * 0.075;
  const height = 0.25 + ((gx * 17 + gz * 31) % 19) * 0.035;
  const angle = local / 12 * Math.PI * 2;
  const y = (local % 4) / 3 * height - height * 0.35;
  const x = x0 + Math.cos(angle) * 0.026 + (random() - 0.5) * 0.008;
  const z = z0 + Math.sin(angle) * 0.026 + (random() - 0.5) * 0.008;
  const hue = ((gx * 7 + gz * 13) % 23) / 23;
  const r = 0.28 + 0.55 * hue;
  const g = 0.45 + 0.35 * (1 - hue);
  const b = 0.62 + 0.25 * Math.sin(hue * Math.PI);
  return [
    x, y, z, 0, 0, 0,
    (r - 0.5) / 0.28209479,
    (g - 0.5) / 0.28209479,
    (b - 0.5) / 0.28209479,
    2.2, -4.75, -4.55, -4.75, 1, 0, 0, 0
  ];
}

async function writeModel(count) {
  const target = resolve(outputRoot, `benchmark-${count}.ply`);
  const stream = createWriteStream(target);
  const header = [
    'ply', 'format binary_little_endian 1.0', `comment generated benchmark with ${count} gaussians`,
    `element vertex ${count}`, ...properties.map(name => `property float ${name}`), 'end_header', ''
  ].join('\n');
  stream.write(header);
  const batchVertices = 8192;
  for (let start = 0; start < count; start += batchVertices) {
    const batchCount = Math.min(batchVertices, count - start);
    const buffer = Buffer.allocUnsafe(batchCount * properties.length * 4);
    for (let i = 0; i < batchCount; i++) {
      const values = vertexValues(start + i, count);
      for (let p = 0; p < values.length; p++) buffer.writeFloatLE(values[p], (i * properties.length + p) * 4);
    }
    if (!stream.write(buffer)) await new Promise(resolveDrain => stream.once('drain', resolveDrain));
  }
  await new Promise((resolveFinish, reject) => {
    stream.on('error', reject);
    stream.end(resolveFinish);
  });
  console.log(`${target} (${count.toLocaleString()} gaussians, ${(count * properties.length * 4 / 1048576).toFixed(1)} MiB payload)`);
}

await mkdir(outputRoot, { recursive: true });
for (const count of counts) await writeModel(count);
