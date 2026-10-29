// Always test the current sources: rebuild dist-test/ before the run.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function globalSetup() {
  execFileSync(process.execPath, [path.resolve(import.meta.dirname, '../../scripts/build.mjs'), '--test'], {
    stdio: 'inherit',
  });
}
