import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function openDatabase(dbPath) {
  if (dbPath !== ':memory:') await mkdir(dirname(dbPath), {recursive: true, mode: 0o700});
  const database = new DatabaseSync(dbPath, {timeout: 5_000});
  let backupPath = null;
  try {
    database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    const oldMemories = tables.includes('memories') && !database.prepare('PRAGMA table_info(memories)').all().some(column => column.name === 'status');
    const oldHistory = tables.includes('conversations') && !database.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'request_id');
    if (dbPath !== ':memory:' && (oldMemories || oldHistory)) {
      const folder = join(dirname(dbPath), 'backups');
      await mkdir(folder, {recursive: true, mode: 0o700});
      backupPath = join(folder, `${basename(dbPath)}.before-v0.3-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`);
      await backup(database, backupPath);
    }
    return {database, backupPath};
  } catch (error) {
    database.close();
    throw error;
  }
}
