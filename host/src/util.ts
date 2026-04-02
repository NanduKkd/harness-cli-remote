import { createHash, randomBytes, randomInt } from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createAccessToken(): string {
  return randomBytes(24).toString('hex');
}

export function createPairingCode(): string {
  const left = randomInt(100, 1000);
  const right = randomInt(100, 1000);
  return `${left}-${right}`;
}

export function clampText(
  value: string | null | undefined,
  limit = 2000,
): string {
  if (!value) {
    return '';
  }

  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

export function summarizeJson(
  value: unknown,
  limit = 1600,
): string | null {
  if (value === undefined) {
    return null;
  }

  const serialized =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  return clampText(serialized, limit);
}

export function extractAfterModelText(input: unknown): string {
  const payload = input as {
    candidates?: Array<{
      content?: {
        parts?: unknown[];
      };
    }>;
  };
  const parts = payload?.candidates?.flatMap((candidate) =>
    Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [],
  );

  return (parts ?? [])
    .filter((part): part is string => typeof part === 'string')
    .join('');
}
