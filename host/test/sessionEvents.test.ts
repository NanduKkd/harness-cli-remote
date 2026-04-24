import assert from 'node:assert/strict';
import test from 'node:test';

import { viewSessionEvent } from '../src/sessionEvents.js';
import type { SessionEventRecord } from '../src/types.js';

test('summary event view strips bulky tool payloads', () => {
  const event: SessionEventRecord = {
    sessionId: 'session-1',
    runId: 'run-1',
    seq: 7,
    type: 'tool.completed',
    ts: '2026-04-23T00:00:00.000Z',
    payload: {
      toolName: 'Read',
      success: true,
      toolInput: {
        path: '/tmp/large.txt',
        body: 'input'.repeat(1000),
      },
      toolResponse: {
        output: 'response'.repeat(1000),
      },
      toolInputSummary: 'path: /tmp/large.txt',
      toolResponseSummary: 'large response omitted',
    },
  };

  const summary = viewSessionEvent(event, 'summary');

  assert.deepEqual(summary.payload, {
    toolName: 'Read',
    success: true,
    toolInputSummary: 'path: /tmp/large.txt',
    toolResponseSummary: 'large response omitted',
  });
  assert.equal('toolInput' in summary.payload, false);
  assert.equal('toolResponse' in summary.payload, false);
  assert.deepEqual(viewSessionEvent(event, 'full'), event);
});

test('summary event view removes stdout from completed runs', () => {
  const event: SessionEventRecord = {
    sessionId: 'session-1',
    runId: 'run-1',
    seq: 8,
    type: 'run.completed',
    ts: '2026-04-23T00:00:00.000Z',
    payload: {
      exitCode: 0,
      signal: null,
      stdoutTail: 'large stdout'.repeat(1000),
      stderrTail: '',
    },
  };

  assert.deepEqual(viewSessionEvent(event, 'summary').payload, {
    exitCode: 0,
    signal: null,
  });
});

test('legacy file_change notifications are normalized into tool events', () => {
  const event: SessionEventRecord = {
    sessionId: 'session-1',
    runId: 'run-1',
    seq: 9,
    type: 'notification',
    ts: '2026-04-23T00:00:00.000Z',
    payload: {
      notificationType: 'file_change',
      message: 'Codex reported File Change activity.',
      details: JSON.stringify({
        id: 'item_28',
        type: 'file_change',
        changes: [
          {
            path: '/tmp/workspace/src/example.ts',
            kind: 'update',
          },
        ],
        status: 'completed',
      }),
    },
  };

  const full = viewSessionEvent(event, 'full');
  const summary = viewSessionEvent(event, 'summary');

  assert.equal(full.type, 'tool.completed');
  assert.deepEqual(full.payload, {
    toolName: 'File Change',
    success: true,
    toolInput: {
      changes: [
        {
          path: '/tmp/workspace/src/example.ts',
          kind: 'update',
        },
      ],
    },
    toolResponse: {
      status: 'completed',
    },
    toolInputSummary:
      '{\n' +
      '  "changes": [\n' +
      '    {\n' +
      '      "path": "/tmp/workspace/src/example.ts",\n' +
      '      "kind": "update"\n' +
      '    }\n' +
      '  ]\n' +
      '}',
    toolResponseSummary: '{\n  "status": "completed"\n}',
  });
  assert.equal(summary.type, 'tool.completed');
  assert.deepEqual(summary.payload, {
    toolName: 'File Change',
    success: true,
    toolInputSummary:
      '{\n' +
      '  "changes": [\n' +
      '    {\n' +
      '      "path": "/tmp/workspace/src/example.ts",\n' +
      '      "kind": "update"\n' +
      '    }\n' +
      '  ]\n' +
      '}',
    toolResponseSummary: '{\n  "status": "completed"\n}',
  });
});
