import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const dataDir = mkdtempSync(join(tmpdir(), 'botmux-observe-e2e-'));
const descriptorDir = join(dataDir, 'dashboard-daemons');
mkdirSync(descriptorDir, { recursive: true });

const sessions = [
  {
    sessionId: 'session-codex-pty', larkAppId: 'cli_e2e', chatId: 'oc_1',
    rootMessageId: 'om_1', scope: 'thread', botName: 'Codex bot',
    cliId: 'codex', runtimeId: 'codex', runtimeDisplayName: 'Codex',
    backendType: 'pty', workerPid: 41001, adopt: false, status: 'working',
    queued: false, workingDir: '/workspace/codex', lastMessageAt: 1700000000000,
  },
  {
    sessionId: 'session-claude-tmux', larkAppId: 'cli_e2e', chatId: 'oc_2',
    rootMessageId: 'om_2', scope: 'thread', botName: 'Claude bot',
    cliId: 'claude-code', runtimeId: 'claude-code', runtimeDisplayName: 'Claude Code',
    backendType: 'tmux', backendSessionName: 'botmux-e2e', adopt: true,
    adoptCliPid: 42002, status: 'idle', queued: true, pendingRepo: true,
    workingDir: '/workspace/claude', lastMessageAt: 1700000001000,
  },
];

const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/sessions') {
    res.end(JSON.stringify({ sessions }));
    return;
  }
  if (req.url === '/api/sessions/session-codex-pty') {
    res.end(JSON.stringify({ session: sessions[0] }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found' }));
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('missing server address');
writeFileSync(join(descriptorDir, 'cli_e2e.json'), JSON.stringify({
  larkAppId: 'cli_e2e', ipcPort: address.port, pid: process.pid,
  bootInstanceId: 'boot-e2e', lastHeartbeat: Date.now(), botName: 'E2E bot', cliId: 'codex',
}));

async function run(args: string[]) {
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('bun', [
      '--preload',
      '/home/haozhenfei/.no-mistakes/evidence/01M31PSGEY6CX959S1K9B9XR3R/mock-node-pty.ts',
      'src/cli.ts',
      'observe',
      ...args,
    ], {
      cwd: root, env: { ...process.env, SESSION_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

try {
  const list = await run(['--lark-app', 'cli_e2e', '--json']);
  if (list.status !== 0) throw new Error(`list exit=${list.status} stderr=${list.stderr}`);
  const listJson = JSON.parse(list.stdout);
  const projected = listJson.daemons[0]?.sessions;
  if (listJson.daemons[0]?.probe?.status !== 'ok' || projected?.length !== 2) {
    throw new Error(`unexpected list output: ${list.stdout}`);
  }
  if (projected[0]?.liveness !== 'alive' || projected[0]?.turn !== 'working' || projected[0]?.phase !== 'unknown') {
    throw new Error(`unexpected codex projection: ${JSON.stringify(projected[0])}`);
  }
  if (projected[1]?.cli?.id !== 'claude-code' || projected[1]?.backend?.type !== 'tmux' || projected[1]?.queued !== true) {
    throw new Error(`unexpected claude projection: ${JSON.stringify(projected[1])}`);
  }
  console.log('=== LIVE DAEMON: botmux observe --lark-app cli_e2e --json (exit 0) ===');
  console.log(JSON.stringify(listJson, null, 2));

  const one = await run(['--session', 'session-codex-pty', '--lark-app', 'cli_e2e', '--json']);
  if (one.status !== 0) throw new Error(`session exit=${one.status} stderr=${one.stderr}`);
  const oneJson = JSON.parse(one.stdout);
  if (oneJson.identity?.sessionId !== 'session-codex-pty' || oneJson.probe?.status !== 'ok') {
    throw new Error(`unexpected session output: ${one.stdout}`);
  }
  console.log('=== LIVE DAEMON: botmux observe --session session-codex-pty (exit 0) ===');
  console.log(JSON.stringify(oneJson, null, 2));

  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  const failed = await run(['--session', 'session-codex-pty', '--lark-app', 'cli_e2e', '--timeout-ms', '250', '--json']);
  if (failed.status !== 1) throw new Error(`offline exit=${failed.status} stderr=${failed.stderr}`);
  const failedJson = JSON.parse(failed.stdout);
  if (failedJson.probe?.status !== 'unreachable' || failedJson.liveness !== 'unknown' || failedJson.turn !== 'unknown' || failedJson.queued !== 'unknown') {
    throw new Error(`unexpected failure output: ${failed.stdout}`);
  }
  console.log('=== STOPPED DAEMON: same observe request (exit 1, no cached facts) ===');
  console.log(JSON.stringify(failedJson, null, 2));
} finally {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
