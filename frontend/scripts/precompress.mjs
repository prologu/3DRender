import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'dist');
const compressible = new Set(['.js', '.css', '.html', '.json', '.wasm']);
let sourceBytes = 0;
let compressedBytes = 0;

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!compressible.has(extname(entry.name)) || entry.name.endsWith('.gz')) continue;
    const target = `${path}.gz`;
    await unlink(target).catch(() => {});
    await pipeline(createReadStream(path), createGzip({ level: 9 }), createWriteStream(target));
    sourceBytes += (await stat(path)).size;
    compressedBytes += (await stat(target)).size;
  }
}

await visit(dist);
console.log(`Precompressed static assets: ${(sourceBytes / 1048576).toFixed(2)} MiB -> ${(compressedBytes / 1048576).toFixed(2)} MiB`);
