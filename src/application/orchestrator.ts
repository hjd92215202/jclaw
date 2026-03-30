import path from "node:path";
import { ROLE_CHAIN, ROLE_CONTRACTS, ROLE_LABELS } from "../domain/roles.js";
import { DEFAULT_TASK_PRESET } from "../domain/task-presets.js";
import type {
  ApprovalInput,
  ChatMessage,
  ExecutionRecord,
  ExecutionRequest,
  GateDecision,
  ManagedProject,
  RetryInput,
  RollbackInput,
  Role,
  Task,
  TaskInput
} from "../domain/types.js";
import { ArtifactStore } from "../infrastructure/artifacts/artifact-store.js";
import { CodexExecutor } from "../infrastructure/execution/codex-executor.js";
import { GitService } from "../infrastructure/git/git-service.js";
import { SQLiteStore } from "../infrastructure/store/sqlite-store.js";
import { id, nowIso } from "../shared/utils.js";

export class Orchestrator {
  private readonly gitByRepoPath = new Map<string, GitService>();

  constructor(
    private readonly store: SQLiteStore,
    private readonly managedProjectsRootPath: string,
    private readonly executor: CodexExecutor,
    private readonly artifacts: ArtifactStore
  ) {}

  listTasks(): Task[] {
    return this.store.listTasks();
  }

  getTask(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`任务不存在：${taskId}`);
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
    const project = this.resolveManagedProject(input);
    const workspace = await this.getGit(project.repoPath).createTaskWorkspace(taskId);
    const now = nowIso();

    const task: Task = {
      id: taskId,
      projectId: project.id,
      projectName: project.name,
      projectRepoPath: project.repoPath,
      title: input.title,
      goal: input.goal,
      status: "InProgress",
      currentRoleIndex: 0,
      roles: ROLE_CHAIN,
      projectBranchName: workspace.branchName,
      projectBaseBranch: workspace.baseBranch,
      worktreePath: workspace.worktreePath,
      startCommit: workspace.startCommit,
      lastApprovedCommit: workspace.startCommit,
      createdAt: now,
      updatedAt: now,
      rejectedCount: 0,
      budgetConsumed: 0,
      budgetPolicy: { ...DEFAULT_TASK_PRESET.budgetPolicy, ...input.budgetPolicy },
      constraints: this.withPreset(input.constraints, DEFAULT_TASK_PRESET.constraints),
      acceptanceCriteria: this.withPreset(input.acceptanceCriteria, DEFAULT_TASK_PRESET.acceptanceCriteria),
      events: []
    };

    task.events.push({
      id: id("evt"),
      taskId,
      type: "TaskCreated",
      actor: "system",
      timestamp: now,
      detail: `Task created in managed project ${project.name} with workspace ${path.relative(process.cwd(), workspace.worktreePath)}`
    });

    return this.store.createTask(task);
  }

  async runRole(taskId: string, explicitRole?: Role): Promise<ExecutionRecord> {
    const task = this.getTask(taskId);
    const role = explicitRole ?? this.getCurrentRole(task);
    const expected = this.getCurrentRole(task);
    if (role !== expected) {
      throw new Error(`当前不能执行${ROLE_LABELS[role]}，请先执行${ROLE_LABELS[expected]}。`);
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
      throw new Error("预算熔断已触发，请先调整预算或人工干预。");
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
        reviewStatus: undefined,
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
        detail: `Role ${role} execution started in managed project ${task.projectName} (attempt ${attempt}).`
      });

      const result = await this.executor.execute(task.worktreePath, request);
      const checkpoint =
        result.status === "Succeeded"
          ? await this.getGit(task.projectRepoPath).commitCheckpoint(task.worktreePath, `task(${task.id}): ${role} checkpoint`)
          : undefined;
      const diffSummary = await this.getGit(task.projectRepoPath).getDiffSummary(task.worktreePath);

      lastExecution = this.store.updateExecution(taskId, executionId, {
        status: result.status,
        reviewStatus: result.status === "Succeeded" ? "PendingPM" : undefined,
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

      const artifactPath = await this.artifacts.saveExecutionArtifact({ task, execution: lastExecution });
      lastExecution = this.store.updateExecution(taskId, executionId, { artifactPath });

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

      await this.getGit(task.projectRepoPath).rollbackTo(task.worktreePath, task.startCommit);
      task.status = "Blocked";
      task.events.push({
        id: id("evt"),
        taskId,
        type: "Rollback",
        actor: "system",
        timestamp: nowIso(),
        detail: `Auto rollback to ${task.startCommit} in managed project ${task.projectName} after failure.`
      });
      this.store.saveTask(task);
      return lastExecution;
    }

    if (!lastExecution) {
      throw new Error("执行流程异常结束。");
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
      if (latest && latest.role === activeRole) {
        this.store.updateExecution(taskId, latest.id, { reviewStatus: "ApprovedByPM" });
      }

      if (task.currentRoleIndex < task.roles.length - 2) {
        task.currentRoleIndex += 1;
        task.status = "InProgress";
      } else {
        await this.getGit(task.projectRepoPath).publishTaskBranch(task.projectBranchName, task.projectBaseBranch);
        task.currentRoleIndex = task.roles.length - 1;
        task.status = "Done";
        task.events.push({
          id: id("evt"),
          taskId,
          type: "Publish",
          actor: "system",
          timestamp: nowIso(),
          detail: `Merged ${task.projectBranchName} into managed project base branch ${task.projectBaseBranch}`
        });
      }

      logDecision("Approve", input.reason);
      task.updatedAt = nowIso();
      return this.store.saveTask(task);
    }

    await this.getGit(task.projectRepoPath).rollbackTo(task.worktreePath, task.lastApprovedCommit);
    task.rejectedCount += 1;
    task.status = "Rejected";
    const latest = this.store.getLastExecution(taskId);
    if (latest && latest.role === activeRole) {
      this.store.updateExecution(taskId, latest.id, { reviewStatus: "RejectedByPM" });
    }
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
      throw new Error("手动回滚模式必须提供 targetCommit。");
    }

    await this.getGit(task.projectRepoPath).rollbackTo(task.worktreePath, target);
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

  private withPreset(value: string[] | undefined, preset: string[]): string[] {
    if (!value || value.length === 0) {
      return [...preset];
    }
    const normalized = value.map((item) => item.trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : [...preset];
  }

  private resolveManagedProject(input: TaskInput): ManagedProject {
    if (input.projectId) {
      const existing = this.store.getProject(input.projectId);
      if (!existing) {
        throw new Error(`托管项目不存在：${input.projectId}`);
      }
      return existing;
    }

    const requestedName = input.project?.name?.trim();
    if (requestedName) {
      const existing = this.store
        .listProjects()
        .find((project) => project.name.toLowerCase() === requestedName.toLowerCase());
      if (existing) {
        return existing;
      }
      return this.createManagedProject(requestedName);
    }

    const existingDefault = this.store.getProject("default");
    if (existingDefault) {
      return existingDefault;
    }
    return this.createManagedProject("默认托管项目", "default");
  }

  private createManagedProject(name: string, preferredId?: string): ManagedProject {
    const projectId = preferredId ?? id("project");
    const now = nowIso();
    const project: ManagedProject = {
      id: projectId,
      name,
      source: "internal-managed",
      repoPath: path.join(this.managedProjectsRootPath, projectId, "repo"),
      defaultBranch: "master",
      createdAt: now,
      updatedAt: now
    };
    return this.store.createProject(project);
  }

  private getGit(repoPath: string): GitService {
    const abs = path.resolve(repoPath);
    const existing = this.gitByRepoPath.get(abs);
    if (existing) {
      return existing;
    }
    const created = new GitService(abs);
    this.gitByRepoPath.set(abs, created);
    return created;
  }
}
