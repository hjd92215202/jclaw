import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ChatMessage, ExecutionRecord, Task } from "../../domain/types.js";

type JsonRow = { data: string };

export class SQLiteStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.init();
  }

  createTask(task: Task): Task {
    this.db
      .prepare("INSERT INTO tasks (id, created_at, data) VALUES (?, ?, ?)")
      .run(task.id, task.createdAt, JSON.stringify(task));
    return task;
  }

  listTasks(): Task[] {
    const rows = this.db.prepare("SELECT data FROM tasks ORDER BY created_at ASC").all() as JsonRow[];
    return rows.map((row) => JSON.parse(row.data) as Task);
  }

  getTask(taskId: string): Task | undefined {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id = ?").get(taskId) as JsonRow | undefined;
    return row ? (JSON.parse(row.data) as Task) : undefined;
  }

  saveTask(task: Task): Task {
    this.db
      .prepare("UPDATE tasks SET data = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(task), task.updatedAt, task.id);
    return task;
  }

  addExecution(record: ExecutionRecord): ExecutionRecord {
    this.db
      .prepare("INSERT INTO executions (id, task_id, started_at, data) VALUES (?, ?, ?, ?)")
      .run(record.id, record.taskId, record.startedAt, JSON.stringify(record));
    return record;
  }

  updateExecution(taskId: string, executionId: string, patch: Partial<ExecutionRecord>): ExecutionRecord {
    const row = this.db
      .prepare("SELECT data FROM executions WHERE id = ? AND task_id = ?")
      .get(executionId, taskId) as JsonRow | undefined;
    if (!row) {
      throw new Error(`Unknown execution: ${executionId}`);
    }
    const current = JSON.parse(row.data) as ExecutionRecord;
    const merged = { ...current, ...patch };
    this.db
      .prepare("UPDATE executions SET data = ?, ended_at = ? WHERE id = ? AND task_id = ?")
      .run(JSON.stringify(merged), merged.endedAt ?? null, executionId, taskId);
    return merged;
  }

  getExecutions(taskId: string): ExecutionRecord[] {
    const rows = this.db
      .prepare("SELECT data FROM executions WHERE task_id = ? ORDER BY started_at ASC")
      .all(taskId) as JsonRow[];
    return rows.map((row) => JSON.parse(row.data) as ExecutionRecord);
  }

  getLastExecution(taskId: string): ExecutionRecord | undefined {
    const row = this.db
      .prepare("SELECT data FROM executions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(taskId) as JsonRow | undefined;
    return row ? (JSON.parse(row.data) as ExecutionRecord) : undefined;
  }

  addMessage(message: ChatMessage): ChatMessage {
    this.db
      .prepare("INSERT INTO messages (id, task_id, timestamp, data) VALUES (?, ?, ?, ?)")
      .run(message.id, message.taskId, message.timestamp, JSON.stringify(message));
    return message;
  }

  getMessages(taskId: string): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT data FROM messages WHERE task_id = ? ORDER BY timestamp ASC")
      .all(taskId) as JsonRow[];
    return rows.map((row) => JSON.parse(row.data) as ChatMessage);
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_executions_task_started
      ON executions(task_id, started_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_task_timestamp
      ON messages(task_id, timestamp);
    `);
  }
}

