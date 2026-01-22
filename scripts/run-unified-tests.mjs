import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const mochaBin = resolve(__dirname, '../node_modules/mocha/bin/mocha');

const env = {
  ...process.env,
  TS_NODE_PROJECT: process.env.TS_NODE_PROJECT ?? 'tsconfig.test.json',
};

const args = ['--loader', 'ts-node/esm', mochaBin, 'test/unified/*.test.ts'];

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env,
});

child.on('close', code => {
  process.exit(code ?? 0);
});

child.on('error', err => {
  console.error('Failed to run unified tests:', err);
  process.exit(1);
});
