import {
  createHash,
  randomBytes,
  timingSafeEqual,
  type BinaryLike,
} from 'node:crypto';
import path from 'node:path';

export const PAIRING_PASSWORD_ENV_VAR = 'GEMINI_REMOTE_PAIRING_PASSWORD';

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(value: BinaryLike): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createAccessToken(): string {
  return randomBytes(24).toString('hex');
}

export function readPairingPasswordFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const password = env[PAIRING_PASSWORD_ENV_VAR]?.trim();
  if (!password) {
    throw new Error(
      `Missing ${PAIRING_PASSWORD_ENV_VAR}. Set it before starting the host daemon.`,
    );
  }

  return password;
}

export function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
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

export function sanitizeFilename(input: string): string {
  const trimmed = input.trim();
  const normalized = trimmed.replaceAll('\\', '/');
  const base = path.basename(normalized);
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'artifact.bin';
}

export function guessMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.json':
      return 'application/json';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.xml':
      return 'application/xml';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

export function isSubPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
