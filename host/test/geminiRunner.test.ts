import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGeminiArgs, GeminiRunner } from '../src/geminiRunner.js';

test('buildGeminiArgs adds a model override when provided', () => {
  const args = buildGeminiArgs(
    {
      providerSessionId: null,
      geminiSessionId: null,
    },
    'hello',
    false,
    'gemini-2.5-pro',
  );

  assert.deepEqual(args, [
    '--yolo',
    '--output-format',
    'json',
    '--model',
    'gemini-2.5-pro',
    '-p',
    'hello',
  ]);
});

test('buildGeminiArgs resumes with the saved session id and model', () => {
  const args = buildGeminiArgs(
    {
      providerSessionId: 'gemini-session-1',
      geminiSessionId: 'gemini-session-1',
    },
    'follow up',
    true,
    'gemini-2.5-flash',
  );

  assert.deepEqual(args, [
    '--yolo',
    '--output-format',
    'json',
    '--model',
    'gemini-2.5-flash',
    '--resume',
    'gemini-session-1',
    '-p',
    'follow up',
  ]);
});

test('GeminiRunner finalize falls back to stdout JSON for final output', () => {
  const runner = new GeminiRunner();
  const emitted: any[] = [];

  const controls: any = {
    getLatestCompletedMessage: () => null,
    getRun: () => null,
    emit: (sessionId: string, runId: string, event: any) => {
      emitted.push(event);
      return event;
    },
  };

  const runtime: any = {
    sessionId: 'session-1',
    runId: 'run-1',
    stdoutTail: 'some hook logs\n{"response": "hello from json", "stats": {"tokens": 123}}\n',
    state: { fallbackMessageText: null },
  };

  const runRecord: any = { id: 'run-1', sessionId: 'session-1' };

  runner.finalize(runtime, runRecord, 0, null, controls);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'message.completed');
  assert.equal(emitted[0].payload.text, 'hello from json');
  assert.equal(emitted[0].payload.source, 'gemini-json');
  assert.deepEqual(emitted[0].payload.usage, { input: 0, output: 0, total: 123 });
});
