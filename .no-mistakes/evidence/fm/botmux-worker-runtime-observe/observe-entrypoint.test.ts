import { expect, mock, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

mock.module('node-pty', () => ({
  spawn() { throw new Error('node-pty is outside the observe command path'); },
}));

test('top-level botmux observe dispatches to the canonical command', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-observe-entry-'));
  mkdirSync(join(dataDir, 'dashboard-daemons'));
  mkdirSync(join(homedir(), '.botmux'), { recursive: true });
  writeFileSync(join(homedir(), '.botmux', '.dashboard-secret'), 'entry-secret', { mode: 0o600 });
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ session: {
      sessionId: 'entry-s1', larkAppId: 'cli_entry', cliId: 'gemini',
      backendType: 'tmux', status: 'idle', queued: false, adopt: false,
    } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  writeFileSync(join(dataDir, 'dashboard-daemons', 'cli_entry.json'), JSON.stringify({
    larkAppId: 'cli_entry', ipcPort: address.port, pid: process.pid, lastHeartbeat: Date.now(),
  }));
  const previousArgv = process.argv;
  const previousDataDir = process.env.SESSION_DATA_DIR;
  const previousExitCode = process.exitCode;
  const previousWrite = process.stdout.write;
  let stdout = '';
  try {
    process.argv = ['bun', 'src/cli.ts', 'observe', '--session', 'entry-s1', '--lark-app', 'cli_entry', '--json'];
    process.env.SESSION_DATA_DIR = dataDir;
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
    await import('../../worktrees/19553d98b60a/01M31PSGEY6CX959S1K9B9XR3R/src/cli.ts');
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      probe: { status: 'ok', source: 'daemon-ipc' }, identity: { sessionId: 'entry-s1' },
      cli: { id: 'gemini' }, backend: { type: 'tmux' }, liveness: 'alive',
      turn: 'idle', phase: 'unknown', queued: false,
    });
  } finally {
    process.argv = previousArgv;
    process.env.SESSION_DATA_DIR = previousDataDir;
    process.exitCode = previousExitCode;
    process.stdout.write = previousWrite;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
