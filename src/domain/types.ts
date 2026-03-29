export type Role = "PM" | "Architect" | "Designer" | "SeniorDeveloper" | "QA" | "Ops";

export type TaskStatus =
  | "Draft"
  | "InProgress"
  | "Blocked"
  | "WaitingPM"
  | "Approved"
  | "Rejected"
  | "Done";

export type ExecutionStatus =
  | "Pending"
  | "Running"
  | "Timeout"
  | "Retrying"
  | "Failed"
  | "Succeeded"
  | "CircuitOpen";

export type RollbackMode = "AutoToCheckpoint" | "ManualSelectCommit";

export type ArtifactType =
  | "PRD"
  | "ArchSpec"
  | "UIDesign"
  | "CodePatch"
  | "TestReport"
  | "Runbook"
  | "ReleaseNote";

export type GateDecision = "Approve" | "Reject" | "Rework";

export interface BudgetPolicy {
  hardLimit: number;
  softLimit: number;
  fallbackModel: string;
  circuitBreakerAt: number;
}

export interface TaskInput {
  title: string;
  goal: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  budgetPolicy?: Partial<BudgetPolicy>;
  repoPath?: string;
}

export interface Task {
  id: string;
  repoPath: string;
  title: string;
  goal: string;
  status: TaskStatus;
  currentRoleIndex: number;
  roles: Role[];
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  startCommit: string;
  lastApprovedCommit: string;
  createdAt: string;
  updatedAt: string;
  rejectedCount: number;
  budgetConsumed: number;
  budgetPolicy: BudgetPolicy;
  constraints: string[];
  acceptanceCriteria: string[];
  events: TaskEvent[];
}

export interface ExecutionRequest {
  taskId: string;
  role: Role;
  goal: string;
  contextFiles: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  budgetLimit: number;
  timeoutSec: number;
  retries: number;
}

export interface ExecutionRecord {
  id: string;
  taskId: string;
  role: Role;
  promptVersion: string;
  status: ExecutionStatus;
  reviewStatus?: "PendingPM" | "ApprovedByPM" | "RejectedByPM";
  command: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  durationMs?: number;
  stdout: string;
  stderr: string;
  diffSummary: string;
  estimatedCost: number;
  attempt: number;
  retriable: boolean;
  checkpointCommit?: string;
  artifactPath?: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type:
    | "TaskCreated"
    | "ExecutionStarted"
    | "ExecutionFinished"
    | "GateDecision"
    | "Rollback"
    | "Retry"
    | "CircuitOpen"
    | "Publish";
  actor: Role | "system" | "PM";
  timestamp: string;
  detail: string;
}

export interface ChatMessage {
  id: string;
  taskId: string;
  role: Role | "PM";
  content: string;
  timestamp: string;
}

export interface ApprovalInput {
  decision: GateDecision;
  reason?: string;
}

export interface RetryInput {
  role?: Role;
}

export interface RollbackInput {
  mode: RollbackMode;
  targetCommit?: string;
}
