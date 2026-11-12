import { spawn } from 'node:child_process';

const publicPort = process.env.PORT || '3000';
const apiPort = process.env.SENTRA_API_PORT || '4000';
const api = spawn('pnpm', ['--filter', '@sentra/service', 'start'], {
  env: { ...process.env, PORT: apiPort, HOST: '127.0.0.1' },
  stdio: 'inherit',
});
const web = spawn('pnpm', ['--filter', '@sentra/web', 'start'], {
  env: { ...process.env, PORT: publicPort, HOSTNAME: '0.0.0.0' },
  stdio: 'inherit',
});

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  api.kill('SIGTERM');
  web.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1000).unref();
};

api.once('exit', (code) => {
  if (!stopping) stop(code || 1);
});
web.once('exit', (code) => {
  if (!stopping) stop(code || 1);
});
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
