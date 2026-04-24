import type { SessionEventRecord } from './types.js';
import { summarizeJson } from './util.js';

export type SessionEventPayloadMode = 'full' | 'summary';

export function toSessionEventPayloadMode(
  value: string | undefined,
): SessionEventPayloadMode {
  return value === 'summary' ? 'summary' : 'full';
}

export function viewSessionEvent(
  event: SessionEventRecord,
  mode: SessionEventPayloadMode,
): SessionEventRecord {
  const normalized = normalizeLegacyEvent(event);
  if (mode === 'full') {
    return normalized;
  }

  return {
    ...normalized,
    payload: summarizePayload(normalized.type, normalized.payload),
  };
}

function normalizeLegacyEvent(event: SessionEventRecord): SessionEventRecord {
  if (
    event.type !== 'notification' ||
    event.payload.notificationType !== 'file_change'
  ) {
    return event;
  }

  const detailPayload =
    typeof event.payload.details === 'string'
      ? tryParseJsonObject(event.payload.details)
      : null;
  const changes = detailPayload?.changes ?? null;
  const status = detailPayload?.status ?? 'completed';

  return {
    ...event,
    type: 'tool.completed',
    payload: stripUndefined({
      toolName: 'File Change',
      success: true,
      toolInput: {
        changes,
      },
      toolResponse: {
        status,
      },
      toolInputSummary: summarizeJson({ changes }),
      toolResponseSummary: summarizeJson({ status }),
    }),
  };
}

function summarizePayload(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case 'tool.started':
      return stripUndefined({
        toolName: payload.toolName ?? null,
        toolInputSummary:
          payload.toolInputSummary ?? summarizeJson(payload.toolInput),
      });
    case 'tool.completed':
      return stripUndefined({
        toolName: payload.toolName ?? null,
        success: payload.success ?? true,
        toolInputSummary:
          payload.toolInputSummary ?? summarizeJson(payload.toolInput),
        toolResponseSummary:
          payload.toolResponseSummary ?? summarizeJson(payload.toolResponse),
      });
    case 'run.completed':
      return stripUndefined({
        exitCode: payload.exitCode ?? null,
        signal: payload.signal ?? null,
        recovered: payload.recovered,
      });
    case 'run.failed':
    case 'run.cancelled':
      return stripUndefined({
        exitCode: payload.exitCode ?? null,
        signal: payload.signal ?? null,
        stderrTail: payload.stderrTail ?? '',
        recovered: payload.recovered,
      });
    default:
      return payload;
  }
}

function stripUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function tryParseJsonObject(
  value: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
