import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const api = fileURLToPath(new URL('../', import.meta.url));
const admin = fileURLToPath(new URL('../../wkbdy-api-admin/', import.meta.url));
if (!existsSync(join(admin, 'package.json'))) {
  throw new Error('Check out wkbdy-api and wkbdy-api-admin into sibling directories');
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const [cwd, script] of [
  [api, 'typecheck'],
  [api, 'test'],
  [api, 'build'],
  [admin, 'typecheck'],
  [admin, 'build'],
  [admin, 'deploy:assets'],
  [api, 'smoke'],
  [api, 'verify:release'],
]) {
  const result = spawnSync(npm, ['run', script], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('CI verification passed for both repositories.');
