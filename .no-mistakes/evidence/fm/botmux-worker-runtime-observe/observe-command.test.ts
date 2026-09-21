import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runObserveCommand } from '../../worktrees/19553d98b60a/01M31PSGEY6CX959S1K9B9XR3R/src/cli/observe-command.ts';

const dirs: string[] = [];
let server: Server | undefined;
afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-observe-command-'));
  dirs.push(dataDir);
  mkdirSync(join(dataDir, 'dashboard-daemons'));
  mkdirSync(join(homedir(), '.botmux'), { recursive: true });
  writeFileSync(join(homedir(), '.botmux', '.dashboard-secret'), 'e2e-secret', { mode: 0o600 });
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const row = { sessionId: 's1', larkAppId: 'cli_test', cliId: 'codex', backendType: 'pty', workerPid: 99, status: 'working', queued: false };
    res.end(JSON.stringify(req.url === '/api/sessions' ? { sessions: [row] } : { session: row }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  writeFileSync(join(dataDir, 'dashboard-daemons', 'cli_test.json'), JSON.stringify({
    larkAppId: 'cli_test', ipcPort: address.port, pid: process.pid, lastHeartbeat: Date.now(),
  }));
  process.env.SESSION_DATA_DIR = dataDir;
}

async function capture(args: string[]) {
  let stdout = '';
  let stderr = '';
  const oldOut = process.stdout.write;
  const oldErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const code = await runObserveCommand(args);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = oldOut;
    process.stderr.write = oldErr;
  }
}

describe('observe command public behavior', () => {
  it('prints canonical live facts from daemon IPC', async () => {
    await fixture();
    const result = await capture(['--session', 's1', '--lark-app', 'cli_test', '--json']);
    expect(result, result.stdout + result.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(result.stdout)).toMatchObject({
      probe: { status: 'ok', source: 'daemon-ipc' }, identity: { sessionId: 's1' },
      cli: { id: 'codex' }, backend: { type: 'pty' }, liveness: 'alive',
      turn: 'working', phase: 'unknown', queued: false,
    });
  });

  it('returns exit 1 and unknown facts when the discovered daemon is unreachable', async () => {
    await fixture();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    const result = await capture(['--session', 's1', '--lark-app', 'cli_test', '--timeout-ms', '50', '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      probe: { status: 'unreachable', source: 'daemon-ipc' }, identity: { sessionId: 's1' },
      liveness: 'unknown', turn: 'unknown', phase: 'unknown', queued: 'unknown',
    });
  });
});
