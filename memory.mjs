import { DatabaseSync } from 'node:sqlite';

const KINDS = new Set(['fact', 'preference', 'project', 'decision', 'goal', 'correction', 'task', 'lesson']);
const STATUSES = new Set(['pending', 'approved', 'forgotten']);
const FIELDS = 'id, kind, content, importance, confidence, status, created_at, updated_at, source_turn_id';
const STOP_WORDS = new Set(`
  что как где когда почему зачем какой какая какие какое
  мне меня мой моя мои мою моего моем наш наша наши нас вас вам ваш ваша
  для про при или без это этот эта эти этом того такой так только уже еще
  все есть был была было были будет быть чтобы можно надо нужно хочу
  расскажи скажи пожалуйста можешь знаете знаешь сделай делать пользователь
  брат братик привет да нет его ее они она оно кто кем тем том чем
  the and for with this that what how why where when which about please
  can could would should will have has had was were are you your yours
  our ours their they them user tell give make want into from not but
  jako jsem jsme jste jsou bude bylo byla ten ta to co jak kde kdy proc
  pro nebo ale muj moje nase vase prosim muzes uz jeste se si ze aby
`.trim().split(/\s+/));

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_MEMORY', statusCode: 400 });
}

function missing() {
  return Object.assign(new Error('Запись памяти не найдена.'), { code: 'MEMORY_NOT_FOUND', statusCode: 404 });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function contentValue(value) {
  if (typeof value !== 'string') throw invalid('Содержание памяти должно быть текстом.');
  const content = value.trim();
  if (!content || content.length > 2000 || !contentKey(content)) {
    throw invalid('Содержание памяти должно содержать от 1 до 2000 символов и хотя бы одну букву или цифру.');
  }
  return content;
}

function memoryValue(value) {
  if (!plainObject(value)) throw invalid('Некорректная запись памяти.');
  const content = contentValue(value.content);
  const kind = value.kind === undefined ? 'fact' : value.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw invalid('Неизвестный тип памяти.');
  const importance = value.importance === undefined ? 5 : value.importance;
  if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
    throw invalid('Важность должна быть целым числом от 1 до 10.');
  }
  const confidence = value.confidence === undefined ? 0.8 : value.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw invalid('Уверенность должна быть числом от 0 до 1.');
  }
  let source_turn_id = null;
  if (value.source_turn_id !== undefined && value.source_turn_id !== null) {
    if (typeof value.source_turn_id !== 'string' || !value.source_turn_id.trim() || value.source_turn_id.length > 128) {
      throw invalid('Некорректный идентификатор исходного сообщения.');
    }
    source_turn_id = value.source_turn_id.trim();
  }
  return { kind, content, importance, confidence, source_turn_id };
}

function memoryId(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw invalid('Некорректный идентификатор памяти.');
  return id;
}

function rowLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw invalid('Лимит должен быть целым числом от 1 до 500.');
  return limit;
}

// Preserve display text. Keys detect typography, case and whitespace repeats,
// not semantic paraphrases.
function contentKey(text) {
  return String(text).normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е')
    .match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
}

function terms(text) {
  return new Set(contentKey(text).split(' ').filter(term => term.length >= 2 && !STOP_WORDS.has(term)).slice(0, 128));
}

function publicRow(row) {
  if (!row) return null;
  const result = { ...row };
  if (result.source_turn_id === null) delete result.source_turn_id;
  return result;
}

/** Importing the module does not open a database. The caller owns a supplied DB. */
export function createMemoryStore({ database, dbPath = new URL('./bratik.db', import.meta.url) } = {}) {
  const ownsDatabase = database === undefined;
  if (!ownsDatabase && !(database instanceof DatabaseSync)) throw invalid('Ожидалось подключение SQLite.');
  const db = database ?? new DatabaseSync(dbPath);
  let closed = false;

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  try {
    if (ownsDatabase) db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    transaction(() => {
      // Additive migration: conversations is neither created nor modified.
      // Retain active for compatibility with existing bratik.db files.
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          kind TEXT NOT NULL DEFAULT 'fact',
          content TEXT NOT NULL UNIQUE,
          importance INTEGER NOT NULL DEFAULT 5,
          confidence REAL NOT NULL DEFAULT 0.8,
          active INTEGER NOT NULL DEFAULT 1
        );
      `);
      const columns = new Set(db.prepare('PRAGMA table_info(memories)').all().map(column => column.name));
      if (!columns.has('status')) {
        db.exec(`ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'forgotten'))`);
        db.exec("UPDATE memories SET status = CASE WHEN active = 1 THEN 'approved' ELSE 'forgotten' END");
      }
      if (!columns.has('source_turn_id')) db.exec('ALTER TABLE memories ADD COLUMN source_turn_id TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_aliases (
          content_key TEXT PRIMARY KEY,
          memory_id INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS memory_aliases_memory ON memory_aliases(memory_id);
        CREATE TABLE IF NOT EXISTS memory_wordings (
          memory_id INTEGER NOT NULL,
          content_key TEXT NOT NULL,
          PRIMARY KEY (memory_id, content_key)
        );
        CREATE TABLE IF NOT EXISTS memory_tombstones (
          content_key TEXT PRIMARY KEY,
          forgotten_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS memories_status ON memories(status, importance DESC);
      `);
      const addAlias = db.prepare('INSERT OR IGNORE INTO memory_aliases(content_key, memory_id) VALUES (?, ?)');
      const addWording = db.prepare('INSERT OR IGNORE INTO memory_wordings(memory_id, content_key) VALUES (?, ?)');
      const addTombstone = db.prepare('INSERT OR IGNORE INTO memory_tombstones(content_key) VALUES (?)');
      // Forgotten variants win the alias when legacy rows differ only by case.
      const existing = db.prepare("SELECT id, content, status FROM memories ORDER BY CASE status WHEN 'forgotten' THEN 0 ELSE 1 END, id").all();
      for (const row of existing) {
        const key = contentKey(row.content);
        if (!key) continue;
        addAlias.run(key, row.id);
        addWording.run(row.id, key);
        if (row.status === 'forgotten') addTombstone.run(key);
      }
      // Aliases pick one canonical record for deduplication, while wordings
      // retain every record's history, including normalized legacy duplicates.
      db.exec(`INSERT OR IGNORE INTO memory_wordings(memory_id, content_key)
        SELECT memory_id, content_key FROM memory_aliases`);
      db.exec(`INSERT OR IGNORE INTO memory_tombstones(content_key)
        SELECT w.content_key FROM memory_wordings w JOIN memories m ON m.id = w.memory_id WHERE m.status = 'forgotten'`);
    });
  } catch (error) {
    if (ownsDatabase) db.close();
    throw error;
  }

  function assertOpen() {
    if (closed) throw new Error('Хранилище памяти закрыто.');
  }

  function get(id) {
    return publicRow(db.prepare(`SELECT ${FIELDS} FROM memories WHERE id = ?`).get(id));
  }

  function tombstoned(key) {
    return Boolean(db.prepare('SELECT 1 FROM memory_tombstones WHERE content_key = ?').get(key));
  }

  function aliasOwner(key) {
    return db.prepare('SELECT memory_id FROM memory_aliases WHERE content_key = ?').get(key)?.memory_id;
  }

  function requireEditable(id) {
    const row = get(id);
    if (!row) throw missing();
    if (row.status === 'forgotten' || tombstoned(contentKey(row.content))) {
      throw invalid('Забытую запись нельзя восстановить или изменить.');
    }
    return row;
  }

  return {
    suggestMemory(value) {
      assertOpen();
      const memory = memoryValue(value);
      const key = contentKey(memory.content);
      return transaction(() => {
        if (tombstoned(key)) return null;
        const owner = aliasOwner(key);
        if (owner !== undefined) {
          const existing = get(owner);
          // Extraction never changes reviewed wording or approval metadata.
          if (existing) return existing.status === 'forgotten' ? null : existing;
        }
        const result = db.prepare(`INSERT INTO memories
          (kind, content, importance, confidence, active, status, source_turn_id)
          VALUES (?, ?, ?, ?, 0, 'pending', ?)`).run(
          memory.kind, memory.content, memory.importance, memory.confidence, memory.source_turn_id,
        );
        const id = Number(result.lastInsertRowid);
        db.prepare('INSERT INTO memory_aliases(content_key, memory_id) VALUES (?, ?)').run(key, id);
        db.prepare('INSERT INTO memory_wordings(memory_id, content_key) VALUES (?, ?)').run(id, key);
        return get(id);
      });
    },

    approveMemory(id) {
      assertOpen();
      memoryId(id);
      return transaction(() => {
        requireEditable(id);
        db.prepare("UPDATE memories SET status = 'approved', active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
        return get(id);
      });
    },

    updateMemory(id, patch) {
      assertOpen();
      memoryId(id);
      if (!plainObject(patch) || Object.keys(patch).some(key => key !== 'content')) throw invalid('Изменять можно только содержание памяти.');
      const content = contentValue(patch.content);
      const key = contentKey(content);
      return transaction(() => {
        requireEditable(id);
        if (tombstoned(key)) throw invalid('Это содержание ранее было забыто.');
        const owner = aliasOwner(key);
        if (owner !== undefined && Number(owner) !== id) throw invalid('Такая запись памяти уже существует.');
        db.prepare('UPDATE memories SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(content, id);
        db.prepare('INSERT OR IGNORE INTO memory_aliases(content_key, memory_id) VALUES (?, ?)').run(key, id);
        db.prepare('INSERT OR IGNORE INTO memory_wordings(memory_id, content_key) VALUES (?, ?)').run(id, key);
        return get(id);
      });
    },

    forgetMemory(id) {
      assertOpen();
      memoryId(id);
      return transaction(() => {
        if (!get(id)) return false;
        db.prepare(`INSERT OR IGNORE INTO memory_tombstones(content_key)
          SELECT content_key FROM memory_wordings WHERE memory_id = ?`).run(id);
        db.prepare("UPDATE memories SET status = 'forgotten', active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
        return true;
      });
    },

    listMemories({ status, limit = 100 } = {}) {
      assertOpen();
      rowLimit(limit);
      if (status !== undefined && status !== 'all' && !STATUSES.has(status)) throw invalid('Неизвестный статус памяти.');
      const condition = status === undefined ? "status IN ('pending', 'approved')" : status === 'all' ? '1 = 1' : 'status = ?';
      const args = status === undefined || status === 'all' ? [limit] : [status, limit];
      return db.prepare(`SELECT ${FIELDS} FROM memories WHERE ${condition}
        ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
          importance DESC, updated_at DESC, id DESC LIMIT ?`).all(...args).map(publicRow);
    },

    relevantMemories(query, limit = 8) {
      assertOpen();
      if (typeof query !== 'string') throw invalid('Запрос для поиска памяти должен быть текстом.');
      rowLimit(limit);
      const queryTerms = terms(query);
      const forgottenKeys = new Set(db.prepare('SELECT content_key FROM memory_tombstones').all().map(row => row.content_key));
      const rows = db.prepare(`SELECT ${FIELDS} FROM memories WHERE status = 'approved'`).all()
        .map(publicRow).filter(row => !forgottenKeys.has(contentKey(row.content)));
      const scored = rows.map(row => {
        const memoryTerms = terms(row.content);
        const overlap = [...queryTerms].filter(term => memoryTerms.has(term)).length;
        return { row, overlap, score: overlap * 10 + Number(row.importance) * 0.2 + Number(row.confidence) * 0.5 };
      });
      const order = (a, b) => b.score - a.score || b.row.id - a.row.id;
      const matching = scored.filter(item => item.overlap > 0).sort(order);
      // Up to two reviewed preferences supply general interaction style.
      // Facts, projects, goals, etc. always require meaningful lexical overlap.
      const generalPreferences = scored.filter(item => item.overlap === 0 && item.row.kind === 'preference'
        && item.row.importance >= 5 && item.row.confidence >= 0.7).sort(order)
        .slice(0, Math.min(2, limit - (matching.length ? 1 : 0)));
      return [...matching.slice(0, limit - generalPreferences.length), ...generalPreferences].map(item => item.row);
    },

    memoryCounts() {
      assertOpen();
      const counts = { pending: 0, approved: 0, forgotten: 0 };
      for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM memories GROUP BY status').all()) {
        if (STATUSES.has(row.status)) counts[row.status] = Number(row.n);
      }
      return counts;
    },

    close() {
      if (closed) return;
      closed = true;
      if (ownsDatabase) db.close();
    },
  };
}
