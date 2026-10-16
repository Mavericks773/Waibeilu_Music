// Stop the service first so the database snapshot and music files match.
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, cp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const source = resolve(process.env.DATA_DIR || 'data');
const targetRoot = process.argv[2];
if (!targetRoot) throw new Error('Usage: node scripts/backup.mjs <backup-directory>');
const target = resolve(targetRoot, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(target, { recursive: true, mode: 0o700 });
const database = new DatabaseSync(join(source, 'music.sqlite'), { readOnly: true });
try {
  await backup(database, join(target, 'music.sqlite'));
  await cp(join(source, 'music'), join(target, 'music'), { recursive: true });
  await writeFile(
    join(target, 'README.txt'),
    'Restore music.sqlite and music/ into DATA_DIR while the service is stopped.\n',
    { mode: 0o600 },
  );
} finally {
  database.close();
}
console.log(target);
