// Bundles src/ into a loadable, unpacked extension.
//
//   node scripts/build.mjs          -> dist/       (what users install)
//   node scripts/build.mjs --test   -> dist-test/  (adds a fixed key, same permissions,
//                                                  so end-to-end tests can find it)
//   node scripts/build.mjs --watch  -> dist/, rebuilt on change
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const testBuild = process.argv.includes('--test');
const watch = process.argv.includes('--watch');
const outdir = path.join(root, testBuild ? 'dist-test' : 'dist');

const entryPoints = {
  popup: 'src/popup/popup.js',
  recorder: 'src/recorder/recorder.js',
};

/** `import text from './file?text'` bundles the file's contents as a string (the replay server). */
const textImports = {
  name: 'text-imports',
  setup(build) {
    build.onResolve({ filter: /\?text$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -'?text'.length)),
      namespace: 'text',
    }));
    build.onLoad({ filter: /.*/, namespace: 'text' }, async (args) => ({
      contents: await fs.readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

/** Chrome refuses extension scripts containing some Unicode noncharacters; ASCII is always safe. */
export async function assertAsciiOutput(dir) {
  for (const name of await fs.readdir(dir, { recursive: true })) {
    if (!/\.(js|html|css|json)$/.test(name)) continue;
    const bytes = await fs.readFile(path.join(dir, name));
    const offending = bytes.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
    if (offending >= 0) throw new Error(`${name}: non-ASCII byte 0x${bytes[offending].toString(16)} at offset ${offending}`);
  }
}

/** Extension ID Chrome derives from a manifest "key". */
function extensionId(publicKeyDer) {
  const hex = createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

async function writeManifest() {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (testBuild) {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    manifest.key = der.toString('base64');
    await fs.writeFile(path.join(outdir, 'extension-id.txt'), extensionId(der));
  }
  await fs.writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function build() {
  await fs.rm(outdir, { recursive: true, force: true });
  await fs.cp(path.join(root, 'extension'), outdir, { recursive: true });
  const options = {
    entryPoints: Object.fromEntries(Object.entries(entryPoints).map(([k, v]) => [k, path.join(root, v)])),
    outdir,
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    charset: 'ascii',
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [textImports],
  };
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
  await writeManifest();
  await assertAsciiOutput(outdir);
  console.log(`Built ${path.relative(root, outdir)}/${watch ? ' (watching)' : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build();
}
