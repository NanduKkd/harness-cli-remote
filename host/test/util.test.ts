import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAIRING_PASSWORD_ENV_VAR,
  readPairingPasswordFromEnv,
  secureEquals,
} from '../src/util.js';

test('readPairingPasswordFromEnv returns the trimmed configured password', () => {
  const password = readPairingPasswordFromEnv({
    [PAIRING_PASSWORD_ENV_VAR]: '  mobile-secret  ',
  } as NodeJS.ProcessEnv);

  assert.equal(password, 'mobile-secret');
});

test('readPairingPasswordFromEnv rejects missing or blank passwords', () => {
  assert.throws(
    () => readPairingPasswordFromEnv({} as NodeJS.ProcessEnv),
    new RegExp(PAIRING_PASSWORD_ENV_VAR),
  );
  assert.throws(
    () =>
      readPairingPasswordFromEnv({
        [PAIRING_PASSWORD_ENV_VAR]: '   ',
      } as NodeJS.ProcessEnv),
    new RegExp(PAIRING_PASSWORD_ENV_VAR),
  );
});

test('secureEquals requires an exact secret match', () => {
  assert.equal(secureEquals('mobile-secret', 'mobile-secret'), true);
  assert.equal(secureEquals('mobile-secret', 'Mobile-secret'), false);
  assert.equal(secureEquals('mobile-secret', 'mobile-secret-2'), false);
});
