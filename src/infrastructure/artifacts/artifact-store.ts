import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionRecord, Task } from "../../domain/types.js";

interface SaveArtifactInput {
  task: Task;
  execution: ExecutionRecord;
}

export class ArtifactStore {
  constructor(private readonly repoPath: string) {}

  async saveExecutionArtifact(input: SaveArtifactInput): Promise<string> {
    const { task, execution } = input;
    const safeRole = execution.role.replace(/\s+/g, "_");
    const stamp = (execution.endedAt ?? execution.startedAt).replace(/[:.]/g, "-");
    const dir = path.join(this.repoPath, ".ai-workbench", "artifacts", task.id, `${stamp}_${safeRole}_a${execution.attempt}`);
    await mkdir(dir, { recursive: true });

    const summary = {
      taskId: task.id,
      title: task.title,
      role: execution.role,
      status: execution.status,
      reviewStatus: execution.reviewStatus,
      attempt: execution.attempt,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      checkpointCommit: execution.checkpointCommit,
      command: execution.command,
      estimatedCost: execution.estimatedCost
    };

    await writeFile(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");
    await writeFile(path.join(dir, "output.txt"), execution.stdout || execution.stderr || "", "utf-8");
    await writeFile(path.join(dir, "diff-summary.txt"), execution.diffSummary || "", "utf-8");

    return dir;
  }
}

