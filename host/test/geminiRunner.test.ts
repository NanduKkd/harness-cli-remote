import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGeminiArgs } from '../src/geminiRunner.js';

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
    '--model',
    'gemini-2.5-flash',
    '--resume',
    'gemini-session-1',
    '-p',
    'follow up',
  ]);
});
