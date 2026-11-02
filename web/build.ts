/** Bundles the extension into Extension/Resources, which Xcode copies into the app extension. */
import { cp, mkdir, rm } from 'node:fs/promises';

const out = new URL('../Extension/Resources/', import.meta.url).pathname;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const result = await Bun.build({
  entrypoints: ['src/background.ts', 'src/content.ts', 'src/popup.ts'],
  outdir: out,
  target: 'browser',
  format: 'esm',
  minify: { syntax: true, whitespace: true },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await cp('static', out, { recursive: true });
