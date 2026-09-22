import { expect, test } from 'bun:test';
import {
  buildOrchestratorReportTrigger,
  deliverReportSessionRelay,
  authorizeReportSessionRelayRequest,
  isReportRelayOriginalSessionUnavailable,
  resolveReportRelayFallbackTarget,
  type ReportSessionRelayTargetView,
} from '/home/haozhenfei/.no-mistakes/worktrees/19553d98b60a/01M355R0HQ80AV3MQR575M68CF/src/core/report-session-relay.ts';
import {
  createDispatchReportBinding,
  resolveVerifiedDispatchReportTarget,
} from '/home/haozhenfei/.no-mistakes/worktrees/19553d98b60a/01M355R0HQ80AV3MQR575M68CF/src/core/dispatch-report-binding.ts';

const decision = {
  ok: true as const,
  source: { sessionId: 'worker-session', larkAppId: 'cli_worker' },
  target: { sessionId: 'signed-original', larkAppId: 'cli_coordinator' },
  targetChatId: 'oc_original',
  targetScope: 'chat' as const,
  dispatchRoot: 'om_dispatch',
  sourceName: 'worker completion',
  content: 'implemented and verified',
  projectUpdate: { status: 'completed' as const, progress: 100, milestone: 'tests green' },
};
const meta = { requestId: 'report:worker-session:1', receivedAt: '2026-09-23T00:00:00.000Z' };
const successor = {
  sessionId: 'current-main',
  larkAppId: 'cli_coordinator',
  chatId: 'oc_original',
  scope: 'chat' as const,
  status: 'idle',
};

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function deliveryTrace(
  firstStatus: number,
  firstBody: unknown,
  sessions: ReportSessionRelayTargetView[],
) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  let triggerCount = 0;
  const result = await deliverReportSessionRelay({
    decision,
    triggerMeta: meta,
    fetchTarget: async (path, init) => {
      calls.push({ path, ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
      if (path === '/api/sessions') return response(200, { sessions });
      triggerCount += 1;
      return triggerCount === 1
        ? response(firstStatus, firstBody)
        : response(202, { ok: true, action: 'accepted' });
    },
    postProjectUpdate: async target => ({
      projectSynced: target.sessionId === 'current-main',
    }),
  });
  return { calls, result };
}

test('typed 404 retries exactly once to the unique live chat-scoped coordinator session', async () => {
  const trace = await deliveryTrace(404, { errorCode: 'session_not_found' }, [
    { ...decision.target, chatId: 'oc_original', scope: 'chat', status: 'closed' },
    successor,
    { ...successor, sessionId: 'wrong-chat', chatId: 'oc_other' },
    { ...successor, sessionId: 'wrong-bot', larkAppId: 'cli_other' },
    { ...successor, sessionId: 'wrong-scope', scope: 'thread' as const },
  ]);
  expect(trace.calls.map(call => call.path)).toEqual(['/api/trigger', '/api/sessions', '/api/trigger']);
  const triggerBodies = trace.calls.filter(call => call.path === '/api/trigger').map(call => call.body as any);
  expect(triggerBodies[1]!.envelope).toEqual(triggerBodies[0]!.envelope);
  expect(triggerBodies[1]!.target).toEqual({
    kind: 'turn', botId: 'cli_coordinator', sessionId: 'current-main',
  });
  expect(trace.result).toMatchObject({
    status: 202,
    body: {
      reportTarget: { sessionId: 'current-main', larkAppId: 'cli_coordinator' },
      originalReportTarget: { sessionId: 'signed-original', larkAppId: 'cli_coordinator' },
      reportFallback: { reason: 'original_session_closed', originalChatId: 'oc_original' },
      projectSynced: true,
    },
  });
  console.log(JSON.stringify({
    scenario: 'typed original-session closed',
    calls: trace.calls.map(call => ({ path: call.path, target: (call.body as any)?.target })),
    retryCount: 1,
    response: trace.result,
    provenancePayload: triggerBodies[1]!.envelope,
  }, null, 2));
});

test('typed 404 also retries when the signed original row was already removed', async () => {
  const trace = await deliveryTrace(404, { errorCode: 'session_not_found' }, [successor]);
  expect(trace.calls.map(call => call.path)).toEqual(['/api/trigger', '/api/sessions', '/api/trigger']);
  expect(trace.result).toMatchObject({
    status: 202,
    body: { reportFallback: { reason: 'original_session_not_found' } },
  });
});

test('normal delivery remains pinned to the signed original target and signed chat provenance', async () => {
  const secret = 'host-secret';
  const reportBinding = createDispatchReportBinding(secret, {
    dispatchRoot: 'om_dispatch',
    targetLarkAppId: 'cli_coordinator',
    targetSessionId: 'signed-original',
    targetChatId: 'oc_original',
    targetScope: 'chat',
    sourceName: 'worker completion',
    issuedAt: '2026-09-23T00:00:00.000Z',
  });
  const verified = resolveVerifiedDispatchReportTarget({
    secret, dispatchRoot: 'om_dispatch', registry: { om_dispatch: { reportBinding } },
  });
  expect(verified).toMatchObject({
    ok: true,
    binding: {
      targetSessionId: 'signed-original', targetLarkAppId: 'cli_coordinator',
      targetChatId: 'oc_original', targetScope: 'chat',
    },
  });
  const normal = await deliveryTrace(200, { ok: true }, [successor]);
  expect(normal.calls.map(call => call.path)).toEqual(['/api/trigger']);
  expect(resolveVerifiedDispatchReportTarget({
    secret,
    dispatchRoot: 'om_dispatch',
    registry: { om_dispatch: {
      reportBinding: {
        ...reportBinding,
        payload: { ...reportBinding.payload, targetChatId: 'oc_attacker' },
      },
    } },
  })).toEqual({ ok: false, error: 'dispatch_binding_unproven' });
  console.log(JSON.stringify({
    scenario: 'normal signed dispatch',
    calls: normal.calls,
    signedProvenance: verified.ok ? {
      chatId: verified.binding.targetChatId, scope: verified.binding.targetScope,
    } : null,
    tamperedBindingAccepted: false,
  }, null, 2));
});

test('timeouts, generic failures, malformed 404s, and ambiguous candidates never retry', async () => {
  const rejected = await Promise.all([
    deliveryTrace(504, { errorCode: 'wait_timeout' }, [successor]),
    deliveryTrace(500, { errorCode: 'trigger_failed' }, [successor]),
    deliveryTrace(404, { error: 'active session not found' }, [successor]),
    deliveryTrace(200, { ok: true, state: 'unknown' }, [successor]),
  ]);
  expect(rejected.map(result => result.calls.length)).toEqual([1, 1, 1, 1]);
  const ambiguous = await deliveryTrace(404, { errorCode: 'session_not_found' }, [
    successor, { ...successor, sessionId: 'another-main', status: 'working' },
  ]);
  expect(ambiguous.calls.map(call => call.path)).toEqual(['/api/trigger', '/api/sessions']);
  expect(ambiguous.result).toMatchObject({ status: 409, body: { error: 'fallback_target_ambiguous' } });
  const noCandidate = await deliveryTrace(404, { errorCode: 'session_not_found' }, [
    { ...successor, sessionId: 'wrong-chat', chatId: 'oc_other' },
    { ...successor, sessionId: 'wrong-bot', larkAppId: 'cli_other' },
    { ...successor, sessionId: 'wrong-scope', scope: 'thread' as const },
  ]);
  expect(noCandidate.calls.map(call => call.path)).toEqual(['/api/trigger', '/api/sessions']);
  expect(noCandidate.result).toMatchObject({ status: 409, body: {
    error: 'fallback_target_unavailable', candidateCount: 0,
  } });
  console.log(JSON.stringify({
    scenario: 'forbidden fallbacks',
    nonTypedCalls: rejected.map(result => result.calls.map(call => call.path)),
    ambiguousCalls: ambiguous.calls.map(call => call.path),
    ambiguousResponse: ambiguous.result,
    noCandidateCalls: noCandidate.calls.map(call => call.path),
    noCandidateResponse: noCandidate.result,
  }, null, 2));
});

test('unproven source authorization cannot reach delivery', () => {
  const secret = 'host-secret';
  const reportBinding = createDispatchReportBinding(secret, {
    dispatchRoot: 'om_dispatch', targetLarkAppId: 'cli_coordinator',
    targetSessionId: 'signed-original', targetChatId: 'oc_original',
    targetScope: 'chat', sourceName: 'worker completion',
    issuedAt: '2026-09-23T00:00:00.000Z',
  });
  const denied = authorizeReportSessionRelayRequest({
    raw: {
      sessionId: 'worker-session', dispatchRoot: 'om_dispatch',
      content: 'implemented and verified', originCapability: 'wrong',
    },
    trustedHost: false,
    session: {
      sessionId: 'worker-session', larkAppId: 'cli_worker', receiver: false,
      scope: 'thread', rootMessageId: 'om_dispatch',
      liveOrigin: { capability: 'c'.repeat(64), turnId: 'turn-1', dispatchAttempt: 1 },
    },
    selfLarkAppId: 'cli_worker',
    registry: { om_dispatch: { reportBinding } },
    bindingSecret: secret,
  });
  expect(denied).toEqual({ ok: false, status: 403, error: 'origin_unproven' });
  console.log(JSON.stringify({ scenario: 'unproven source authorization', decision: denied }, null, 2));
});
