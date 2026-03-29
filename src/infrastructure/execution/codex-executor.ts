import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { ROLE_CONTRACTS } from "../../domain/roles.js";
import type { ExecutionRequest, ExecutionStatus } from "../../domain/types.js";
import { truncate } from "../../shared/utils.js";
import { runCommand } from "./command-runner.js";

export interface CodexExecutionOutput {
  command: string;
  status: ExecutionStatus;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  estimatedCost: number;
  retriable: boolean;
}

export class CodexExecutor {
  async execute(worktreePath: string, request: ExecutionRequest): Promise<CodexExecutionOutput> {
    const prompt = this.buildPrompt(request);
    const timeoutMs = request.timeoutSec * 1000;

    if (process.env.MOCK_CODEX === "1") {
      const simulatedDelay = Number(process.env.MOCK_CODEX_DELAY_MS ?? "100");
      await new Promise((resolve) => setTimeout(resolve, simulatedDelay));
      const fakeStdout = `MOCK CODEX RESULT for ${request.role}: ${request.goal}`;
      return {
        command: "codex exec <mock>",
        status: "Succeeded",
        stdout: truncate(fakeStdout),
        stderr: "",
        exitCode: 0,
        durationMs: simulatedDelay,
        estimatedCost: this.estimateCost(prompt, fakeStdout),
        retriable: false
      };
    }

    await this.ensureCodexAvailable();

    const result = await runCommand(
      "codex",
      [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "-C",
        worktreePath,
        "--json",
        prompt
      ],
      { cwd: worktreePath, timeoutMs }
    );

    const retriable = result.timedOut || this.isRetriable(result.exitCode, result.stderr);
    const status = result.timedOut ? "Timeout" : result.exitCode === 0 ? "Succeeded" : "Failed";

    return {
      command: result.command,
      status,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      estimatedCost: this.estimateCost(prompt, result.stdout + result.stderr),
      retriable
    };
  }

  private async ensureCodexAvailable(): Promise<void> {
    try {
      await access("/usr/local/bin/codex", constants.X_OK);
    } catch {
      const probe = await runCommand("which", ["codex"], { cwd: process.cwd() });
      if (probe.exitCode !== 0) {
        throw new Error("codex CLI not found. Please install codex-cli first.");
      }
    }
  }

  private buildPrompt(request: ExecutionRequest): string {
    const contract = ROLE_CONTRACTS[request.role];
    return [
      "[SYSTEM_PROMPT]",
      contract.systemPrompt,
      "",
      `[TASK_ID] ${request.taskId}`,
      `[ROLE] ${request.role}`,
      `[GOAL] ${request.goal}`,
      `[CONSTRAINTS] ${request.constraints.join(" | ") || "none"}`,
      `[ACCEPTANCE_CRITERIA] ${request.acceptanceCriteria.join(" | ") || "none"}`,
      `[CONTEXT_FILES] ${request.contextFiles.join(",") || "none"}`,
      "",
      "请直接在当前仓库完成对应角色工作；若需要说明，请输出可审计摘要。"
    ].join("\n");
  }

  private isRetriable(exitCode: number, stderr: string): boolean {
    if (exitCode === 0) {
      return false;
    }
    const signal = stderr.toLowerCase();
    return signal.includes("timed out") || signal.includes("temporarily") || signal.includes("network");
  }

  private estimateCost(prompt: string, output: string): number {
    const tokenApprox = Math.ceil((prompt.length + output.length) / 4);
    return Number((tokenApprox * 0.00001).toFixed(4));
  }
}
