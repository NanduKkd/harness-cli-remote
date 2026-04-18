import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexArgs } from '../src/codexRunner.js';

test('buildCodexArgs includes the bypass sandbox flag for new Codex runs', () => {
  const args = buildCodexArgs(null, 'hello', false);
  const execIndex = args.indexOf('exec');

  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('--full-auto'));
  assert.ok(args.some((value) => value.includes('mcp_servers.gemini_remote_artifacts.command')));
  assert.deepEqual(args.slice(execIndex, execIndex + 4), [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--enable',
  ]);
});

test('buildCodexArgs includes a model override before exec when provided', () => {
  const args = buildCodexArgs(
    null,
    'hello',
    false,
    undefined,
    'gpt-5.1-codex-mini',
  );
  const execIndex = args.indexOf('exec');

  assert.equal(args[execIndex - 2], '-m');
  assert.equal(args[execIndex - 1], 'gpt-5.1-codex-mini');
});

test('buildCodexArgs includes the bypass sandbox flag for resumed Codex runs', () => {
  const args = buildCodexArgs('thread-123', 'follow up', true);
  const execIndex = args.indexOf('exec');

  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('--full-auto'));
  assert.ok(args.some((value) => value.includes('mcp_servers.gemini_remote_artifacts.command')));
  assert.deepEqual(args.slice(execIndex, execIndex + 6), [
    'exec',
    'resume',
    'thread-123',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--enable',
  ]);
});
