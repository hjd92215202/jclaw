import path from "node:path";
import { CodexExecutor } from "./codex-executor.js";
import { GitService } from "./git.js";
import { ROLE_CHAIN, ROLE_CONTRACTS } from "./roles.js";
import { InMemoryStore } from "./store.js";
import type {
  ApprovalInput,
  BudgetPolicy,
  ChatMessage,
  ExecutionRecord,
  ExecutionRequest,
  GateDecision,
  RetryInput,
  RollbackInput,
  Role,
  Task,
  TaskInput
} from "./types.js";
import { id, nowIso } from "./utils.js";

const DEFAULT_BUDGET: BudgetPolicy = {
  hardLimit: 20,
  softLimit: 10,
  fallbackModel: "gpt-5.4-mini",
  circuitBreakerAt: 20
};

export class Orchestrator {
  constructor(
    private readonly store: InMemoryStore,
    private readonly git: GitService,
    private readonly executor: CodexExecutor
  ) {}

  listTasks(): Task[] {
    return this.store.listTasks();
  }

  getTask(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  getExecutions(taskId: string): ExecutionRecord[] {
    this.getTask(taskId);
    return this.store.getExecutions(taskId);
  }

  getMessages(taskId: string): ChatMessage[] {
    this.getTask(taskId);
    return this.store.getMessages(taskId);
  }

  addMessage(taskId: string, role: Role | "PM", content: string): ChatMessage {
    this.getTask(taskId);
    return this.store.addMessage({
      id: id("msg"),
      taskId,
      role,
      content,
      timestamp: nowIso()
    });
  }

  async createTask(input: TaskInput): Promise<Task> {
    const taskId = id("task");
    const workspace = await this.git.createTaskWorkspace(taskId);
    const now = nowIso();

    const task: Task = {
      id: taskId,
      title: input.title,
      goal: input.goal,
      status: "InProgress",
      currentRoleIndex: 0,
      roles: ROLE_CHAIN,
      branchName: workspace.branchName,
      baseBranch: workspace.baseBranch,
      worktreePath: workspace.worktreePath,
      startCommit: workspace.startCommit,
      lastApprovedCommit: workspace.startCommit,
      createdAt: now,
      updatedAt: now,
      rejectedCount: 0,
      budgetConsumed: 0,
      budgetPolicy: { ...DEFAULT_BUDGET, ...input.budgetPolicy },
      constraints: input.constraints ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      events: []
    };

    task.events.push({
      id: id("evt"),
      taskId,
      type: "TaskCreated",
      actor: "system",
      timestamp: now,
      detail: `Task created with worktree ${path.relative(process.cwd(), workspace.worktreePath)}`
    });

    return this.store.createTask(task);
  }

  async runRole(taskId: string, explicitRole?: Role): Promise<ExecutionRecord> {
    const task = this.getTask(taskId);
    const role = explicitRole ?? this.getCurrentRole(task);
    const expected = this.getCurrentRole(task);
    if (role !== expected) {
      throw new Error(`Role ${role} is not active. Current role is ${expected}.`);
    }

    if (task.budgetConsumed >= task.budgetPolicy.circuitBreakerAt) {
      task.status = "Blocked";
      task.events.push({
        id: id("evt"),
        taskId,
        type: "CircuitOpen",
        actor: "system",
        timestamp: nowIso(),
        detail: `Budget circuit opened at ${task.budgetConsumed}`
      });
      this.store.saveTask(task);
      throw new Error("Budget circuit breaker is open.");
    }

    const contract = ROLE_CONTRACTS[role];
    const request: ExecutionRequest = {
      taskId,
      role,
      goal: task.goal,
      contextFiles: [],
      constraints: task.constraints,
      acceptanceCriteria: task.acceptanceCriteria,
      budgetLimit: task.budgetPolicy.hardLimit,
      timeoutSec: contract.timeoutSec,
      retries: contract.defaultRetries
    };

    task.status = "InProgress";
    task.updatedAt = nowIso();
    this.store.saveTask(task);

    let attempt = 0;
    let lastExecution: ExecutionRecord | undefined;

    while (attempt <= request.retries) {
      attempt += 1;
      const executionId = id("exec");
      const startedAt = nowIso();

      const baseRecord: ExecutionRecord = {
        id: executionId,
        taskId,
        role,
        promptVersion: contract.promptVersion,
        status: "Running",
        command: "",
        startedAt,
        stdout: "",
        stderr: "",
        diffSummary: "",
        estimatedCost: 0,
        attempt,
        retriable: false
      };

      this.store.addExecution(baseRecord);
      task.events.push({
        id: id("evt"),
        taskId,
        type: "ExecutionStarted",
        actor: role,
        timestamp: startedAt,
        detail: `Role ${role} execution started (attempt ${attempt}).`
      });

      const result = await this.executor.execute(task.worktreePath, request);
      const checkpoint =
        result.status === "Succeeded"
          ? await this.git.commitCheckpoint(task.worktreePath, `task(${task.id}): ${role} checkpoint`) 
          : undefined;
      const diffSummary = await this.git.getDiffSummary(task.worktreePath);

      lastExecution = this.store.updateExecution(taskId, executionId, {
        status: result.status,
        command: result.command,
        endedAt: nowIso(),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        diffSummary,
        estimatedCost: result.estimatedCost,
        retriable: result.retriable,
        checkpointCommit: checkpoint
      });

      task.budgetConsumed = Number((task.budgetConsumed + result.estimatedCost).toFixed(4));
      task.updatedAt = nowIso();
      task.events.push({
        id: id("evt"),
        taskId,
        type: "ExecutionFinished",
        actor: role,
        timestamp: nowIso(),
        detail: `Execution ${result.status}. cost=${result.estimatedCost}`
      });

      if (result.status === "Succeeded") {
        task.status = "WaitingPM";
        this.store.saveTask(task);
        return lastExecution;
      }

      if (result.retriable && attempt <= request.retries) {
        this.store.updateExecution(taskId, executionId, { status: "Retrying" });
        task.events.push({
          id: id("evt"),
          taskId,
          type: "Retry",
          actor: "system",
          timestamp: nowIso(),
          detail: `Retry scheduled for ${role} attempt ${attempt + 1}`
        });
        this.store.saveTask(task);
        continue;
      }

      await this.git.rollbackTo(task.worktreePath, task.startCommit);
      task.status = "Blocked";
      task.events.push({
        id: id("evt"),
        taskId,
        type: "Rollback",
        actor: "system",
        timestamp: nowIso(),
        detail: `Auto rollback to ${task.startCommit} after failure.`
      });
      this.store.saveTask(task);
      return lastExecution;
    }

    if (!lastExecution) {
      throw new Error("Execution ended unexpectedly.");
    }
    return lastExecution;
  }

  async approve(taskId: string, input: ApprovalInput): Promise<Task> {
    const task = this.getTask(taskId);
    const activeRole = this.getCurrentRole(task);

    const logDecision = (decision: GateDecision, reason: string | undefined): void => {
      task.events.push({
        id: id("evt"),
        taskId,
        type: "GateDecision",
        actor: "PM",
        timestamp: nowIso(),
        detail: `${decision} for ${activeRole}${reason ? `: ${reason}` : ""}`
      });
    };

    if (input.decision === "Approve") {
      const latest = this.store.getLastExecution(taskId);
      if (latest?.checkpointCommit) {
        task.lastApprovedCommit = latest.checkpointCommit;
      }

      if (task.currentRoleIndex < task.roles.length - 2) {
        task.currentRoleIndex += 1;
        task.status = "InProgress";
      } else {
        await this.git.publishTaskBranch(task.branchName, task.baseBranch);
        task.currentRoleIndex = task.roles.length - 1;
        task.status = "Done";
        task.events.push({
          id: id("evt"),
          taskId,
          type: "Publish",
          actor: "system",
          timestamp: nowIso(),
          detail: `Merged ${task.branchName} into ${task.baseBranch}`
        });
      }

      logDecision("Approve", input.reason);
      task.updatedAt = nowIso();
      return this.store.saveTask(task);
    }

    await this.git.rollbackTo(task.worktreePath, task.lastApprovedCommit);
    task.rejectedCount += 1;
    task.status = "Rejected";
    logDecision(input.decision, input.reason);
    task.events.push({
      id: id("evt"),
      taskId,
      type: "Rollback",
      actor: "system",
      timestamp: nowIso(),
      detail: `Rollback to last approved commit ${task.lastApprovedCommit}`
    });
    task.updatedAt = nowIso();
    return this.store.saveTask(task);
  }

  async retry(taskId: string, input?: RetryInput): Promise<ExecutionRecord> {
    const task = this.getTask(taskId);
    task.status = "InProgress";
    task.events.push({
      id: id("evt"),
      taskId,
      type: "Retry",
      actor: "system",
      timestamp: nowIso(),
      detail: `Manual retry triggered for ${input?.role ?? this.getCurrentRole(task)}`
    });
    this.store.saveTask(task);
    return this.runRole(taskId, input?.role);
  }

  async rollback(taskId: string, input: RollbackInput): Promise<Task> {
    const task = this.getTask(taskId);
    const target = input.mode === "AutoToCheckpoint" ? task.lastApprovedCommit : input.targetCommit;
    if (!target) {
      throw new Error("targetCommit is required for ManualSelectCommit.");
    }

    await this.git.rollbackTo(task.worktreePath, target);
    task.status = "Blocked";
    task.updatedAt = nowIso();
    task.events.push({
      id: id("evt"),
      taskId,
      type: "Rollback",
      actor: "system",
      timestamp: nowIso(),
      detail: `Manual rollback to ${target}`
    });

    return this.store.saveTask(task);
  }

  private getCurrentRole(task: Task): Role {
    return task.roles[Math.min(task.currentRoleIndex, task.roles.length - 1)];
  }
}
