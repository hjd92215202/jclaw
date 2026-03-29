import type { ChatMessage, ExecutionRecord, Task } from "../../domain/types.js";

export class InMemoryStore {
  private tasks = new Map<string, Task>();
  private executions = new Map<string, ExecutionRecord[]>();
  private messages = new Map<string, ChatMessage[]>();

  createTask(task: Task): Task {
    this.tasks.set(task.id, task);
    this.executions.set(task.id, []);
    this.messages.set(task.id, []);
    return task;
  }

  listTasks(): Task[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  saveTask(task: Task): Task {
    this.tasks.set(task.id, task);
    return task;
  }

  addExecution(record: ExecutionRecord): ExecutionRecord {
    const rows = this.executions.get(record.taskId);
    if (!rows) {
      throw new Error(`Unknown task: ${record.taskId}`);
    }
    rows.push(record);
    return record;
  }

  updateExecution(taskId: string, executionId: string, patch: Partial<ExecutionRecord>): ExecutionRecord {
    const rows = this.executions.get(taskId);
    if (!rows) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const idx = rows.findIndex((item) => item.id === executionId);
    if (idx < 0) {
      throw new Error(`Unknown execution: ${executionId}`);
    }
    rows[idx] = { ...rows[idx], ...patch };
    return rows[idx];
  }

  getExecutions(taskId: string): ExecutionRecord[] {
    return [...(this.executions.get(taskId) ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  getLastExecution(taskId: string): ExecutionRecord | undefined {
    const rows = this.executions.get(taskId) ?? [];
    return rows[rows.length - 1];
  }

  addMessage(message: ChatMessage): ChatMessage {
    const rows = this.messages.get(message.taskId);
    if (!rows) {
      throw new Error(`Unknown task: ${message.taskId}`);
    }
    rows.push(message);
    return message;
  }

  getMessages(taskId: string): ChatMessage[] {
    return [...(this.messages.get(taskId) ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}
