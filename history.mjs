export function createHistoryStore(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      request_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      message TEXT NOT NULL,
      answer TEXT NOT NULL,
      model TEXT NOT NULL,
      memories_json TEXT NOT NULL DEFAULT '[]',
      reflection_state TEXT NOT NULL DEFAULT 'queued',
      reflection_error TEXT,
      reflection_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  if (!database.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'request_id')) {
    database.exec('ALTER TABLE conversations ADD COLUMN request_id TEXT');
  }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS conversation_turn_role ON conversations(request_id, role) WHERE request_id IS NOT NULL');

  function decodeTurn(row) {
    if (!row) return null;
    return {
      request_id: row.request_id,
      created_at: row.created_at,
      message: row.message,
      answer: row.answer,
      model: row.model,
      memories_used: JSON.parse(row.memories_json),
      reflection: {state: row.reflection_state, ...(row.reflection_error ? {error: row.reflection_error} : {})},
    };
  }

  function getTurn(requestId) {
    return decodeTurn(database.prepare('SELECT * FROM turns WHERE request_id = ?').get(requestId));
  }

  function saveTurn({request_id, message, answer, model, memories_used}) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('INSERT INTO turns(request_id,message,answer,model,memories_json) VALUES(?,?,?,?,?)').run(request_id, message, answer, model, JSON.stringify(memories_used));
      const insert = database.prepare('INSERT INTO conversations(role,content,request_id) VALUES(?,?,?)');
      insert.run('user', message, request_id);
      insert.run('assistant', answer, request_id);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return getTurn(request_id);
  }

  return {
    getTurn, saveTurn,
    history({before = null, limit = 60} = {}) {
      const rows = before === null
        ? database.prepare('SELECT id,role,content,created_at,request_id FROM conversations ORDER BY id DESC LIMIT ?').all(limit + 1)
        : database.prepare('SELECT id,role,content,created_at,request_id FROM conversations WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit + 1);
      const has_more = rows.length > limit;
      const messages = rows.slice(0, limit).reverse();
      return {messages, has_more, before: messages[0]?.id ?? null};
    },
    recent(limit = 20) {
      return database.prepare("SELECT role,content FROM conversations WHERE role IN ('user','assistant') ORDER BY id DESC LIMIT ?").all(limit).reverse();
    },
    setReflection(requestId, state, error = null) {
      if (!['queued', 'running', 'completed', 'failed'].includes(state)) throw new Error('Invalid reflection state');
      database.prepare("UPDATE turns SET reflection_state=?, reflection_error=?, reflection_attempts=reflection_attempts+? WHERE request_id=?").run(state, error, state === 'running' ? 1 : 0, requestId);
    },
    nextReflection() {
      return decodeTurn(database.prepare("SELECT * FROM turns WHERE reflection_state='queued' ORDER BY rowid LIMIT 1").get());
    },
    reflectionCounts() {
      const rows = database.prepare('SELECT reflection_state AS state,COUNT(*) AS count FROM turns GROUP BY reflection_state').all();
      const counts = Object.fromEntries(rows.map(row => [row.state, row.count]));
      return {queued: counts.queued || 0, running: Boolean(counts.running), failed: counts.failed || 0};
    },
    recoverInterrupted() {
      return database.prepare("UPDATE turns SET reflection_state='queued',reflection_error=NULL WHERE reflection_state='running'").run().changes;
    },
    retryFailed() {
      return database.prepare("UPDATE turns SET reflection_state='queued',reflection_error=NULL WHERE reflection_state='failed'").run().changes;
    },
    getSetting(key) { return database.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; },
    setSetting(key, value) { database.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); },
    allMessages() { return database.prepare('SELECT id,role,content,created_at,request_id FROM conversations ORDER BY id').all(); },
    allTurns() { return database.prepare('SELECT * FROM turns ORDER BY rowid').all().map(decodeTurn); },
  };
}
