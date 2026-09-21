import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const secret = 'e2e-observe-secret';
const dataDir = join(tmpdir(), `botmux-observe-e2e-${process.pid}`);
const evidenceHome = join(import.meta.dir, 'observe-e2e-home');
let server: Server;
let port = 0;
let failProbe = false;
let verifyHmac: typeof import('/home/haozhenfei/.no-mistakes/worktrees/19553d98b60a/01M31PSGEY6CX959S1K9B9XR3R/src/dashboard/auth.ts').verifyHmac;
let cliAuthBind: typeof import('/home/haozhenfei/.no-mistakes/worktrees/19553d98b60a/01M31PSGEY6CX959S1K9B9XR3R/src/dashboard/auth.ts').cliAuthBind;
let runObserveCommand: typeof import('/home/haozhenfei/.no-mistakes/worktrees/19553d98b60a/01M31PSGEY6CX959S1K9B9XR3R/src/cli/observe-command.ts').runObserveCommand;
let fetchObserveSnapshot: typeof import('/home/haozhenfei/.no-mistakes/worktrees/19553d98b60a/01M31PSGEY6CX959S1K9B9XR3R/src/services/session-observe-fetch.ts').fetchObserveSnapshot;

beforeAll(async () => {
  mkdirSync(join(evidenceHome, '.botmux'), { recursive: true, mode: 0o700 });
  writeFileSync(join(evidenceHome, '.botmux', '.dashboard-secret'), secret, { mode: 0o600 });
  process.env.HOME = evidenceHome;
  ({ verifyHmac, cliAuthBind } = await import('/home/haozhenfei/.no-mistakes/worktrees/19553d98b60a/01M31PSGEY6CX959S1K9B9XR3R/src/dashboard/auth.ts'));
  ({ runObserveCommand } = await import('/home/haozhenfei/.no-mistakes/worktrees/19553d98b60a/01M31PSGEY6CX959S1K9B9XR3R/src/cli/observe-command.ts'));
  ({ fetchObserveSnapshot } = await import('/home/haozhenfei/.no-mistakes/worktrees/19553d98b60a/01M31PSGEY6CX959S1K9B9XR3R/src/services/session-observe-fetch.ts'));
  mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
  writeFileSync(join(dataDir, 'stale-cache.json'), JSON.stringify({
    sessions: [{ sessionId: 'stale', status: 'working', queued: false }],
  }));
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
    const verified = verifyHmac(secret, {
      ts: String(req.headers['x-botmux-cli-ts'] ?? ''),
      nonce: String(req.headers['x-botmux-cli-nonce'] ?? ''),
      sig: String(req.headers['x-botmux-cli-auth'] ?? ''),
    }, req.socket.remoteAddress ?? '', cliAuthBind(req.method ?? 'GET', path, port));
    if (!verified.ok) {
      res.writeHead(401).end(JSON.stringify({ error: verified.reason }));
      return;
    }
    if (failProbe) {
      res.writeHead(503).end(JSON.stringify({ error: 'daemon busy' }));
      return;
    }
    const session = {
      sessionId: 'live-session', larkAppId: 'cli_e2e', chatId: 'oc_e2e',
      scope: 'thread', cliId: 'codex', runtimeId: 'codex',
      backendType: 'tmux', backendSessionName: 'worker-live', workerPid: 4242,
      status: 'working', queued: false, workingDir: '/repo/live',
    };
    if (path === '/api/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessions: [session] }));
    } else if (path === '/api/sessions/live-session') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ session }));
    } else {
      res.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  writeFileSync(join(dataDir, 'dashboard-daemons', 'e2e.json'), JSON.stringify({
    larkAppId: 'cli_e2e', ipcPort: port, pid: process.pid, lastHeartbeat: Date.now(),
  }));
  process.env.SESSION_DATA_DIR = dataDir;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(evidenceHome, { recursive: true, force: true });
});

test('TS facade gets live canonical state over authenticated daemon IPC', async () => {
  const snapshot = await fetchObserveSnapshot({ dataDir, secret });
  expect(snapshot.daemons).toHaveLength(1);
  expect(snapshot.daemons[0]?.probe.status).toBe('ok');
  expect(snapshot.daemons[0]?.sessions[0]).toMatchObject({
    identity: { sessionId: 'live-session', larkAppId: 'cli_e2e' },
    cli: { id: 'codex', runtimeId: 'codex' },
    backend: { type: 'tmux', sessionName: 'worker-live', workerPid: 4242 },
    liveness: 'alive', turn: 'working', phase: 'unknown', queued: false,
  });
  console.log('TS_FACADE_LIVE=' + JSON.stringify(snapshot));
});

test('CLI facade prints the same canonical session JSON and exits zero', async () => {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  let exitCode: number;
  try { exitCode = await runObserveCommand(['--session', 'live-session', '--lark-app', 'cli_e2e', '--json']); }
  finally { process.stdout.write = original; }
  const output = JSON.parse(chunks.join(''));
  expect(exitCode).toBe(0);
  expect(output).toMatchObject({
    probe: { status: 'ok', source: 'daemon-ipc', larkAppId: 'cli_e2e' },
    identity: { sessionId: 'live-session' },
    liveness: 'alive', turn: 'working', phase: 'unknown', queued: false,
  });
  console.log('CLI_LIVE_EXIT=' + exitCode);
  console.log('CLI_LIVE_JSON=' + JSON.stringify(output));
});

test('failed live probe reports unknown and never uses stale persisted data', async () => {
  failProbe = true;
  const snapshot = await fetchObserveSnapshot({ dataDir, secret });
  expect(snapshot.daemons[0]?.probe.status).toBe('unreachable');
  expect(snapshot.daemons[0]?.sessions).toEqual([]);
  console.log('FAILED_PROBE_WITH_STALE_CACHE_PRESENT=' + JSON.stringify(snapshot));
});

test('CLI failure is machine-readable unknown and exits one', async () => {
  failProbe = true;
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  let exitCode: number;
  try { exitCode = await runObserveCommand(['--lark-app', 'cli_e2e', '--json']); }
  finally { process.stdout.write = original; }
  const output = JSON.parse(chunks.join(''));
  expect(exitCode).toBe(1);
  expect(output.daemons[0]).toMatchObject({
    probe: { status: 'unreachable', source: 'daemon-ipc', larkAppId: 'cli_e2e' },
    sessions: [],
  });
  console.log('CLI_FAILED_EXIT=' + exitCode);
  console.log('CLI_FAILED_JSON=' + JSON.stringify(output));
});
