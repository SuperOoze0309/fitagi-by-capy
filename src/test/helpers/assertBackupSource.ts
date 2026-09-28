import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Guards a privacy promise that is easy to break by accident: a backup file must
 * never contain the API key. This asserts against the *source* of the backup
 * builder rather than a runtime value, so it fails the moment someone adds the key
 * back to the exported shape.
 */
export function assertBackupSourceOmitsApiKey(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, '../../services/backup.ts'), 'utf8');

  // The builder must destructure the key out (and never put it back).
  assert.match(
    source,
    /const \{ aiApiKey: _omitted, \.\.\.safeSettings \} = settings;/,
    'createBackup must strip aiApiKey before building the document',
  );

  // The exported document type must not declare the key at all.
  const shape = /export interface BackupDocument \{[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  assert.ok(shape.length > 0, 'BackupDocument interface not found');
  assert.ok(
    !/^\s*aiApiKey/m.test(shape),
    'BackupDocument must not declare an aiApiKey field',
  );
  assert.match(
    shape,
    /settings: Omit<Settings, 'aiApiKey'>/,
    'BackupDocument.settings must omit aiApiKey',
  );
}

export const BACKUP_SOURCE_PATH = 'src/services/backup.ts';
