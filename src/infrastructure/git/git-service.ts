import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../execution/command-runner.js";

interface WorkspaceResult {
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  startCommit: string;
}

export class GitService {
  constructor(private readonly repoPath: string) {}

  async ensureRepoReady(): Promise<void> {
    await mkdir(this.repoPath, { recursive: true });
    const probe = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.repoPath });
    if (probe.exitCode !== 0) {
      await this.mustGit(["init"]);
      await this.mustGit(["add", "-A"]);
      await this.mustGit([
        "-c",
        "user.name=AI Workbench",
        "-c",
        "user.email=ai-workbench@local",
        "commit",
        "--allow-empty",
        "-m",
        "chore: bootstrap repository"
      ]);
    }
  }

  async createTaskWorkspace(taskId: string): Promise<WorkspaceResult> {
    await this.ensureRepoReady();
    const startCommit = await this.getHeadCommit(this.repoPath);
    const baseBranch = await this.getCurrentBranch(this.repoPath);
    const branchName = `task/${taskId}`;
    const worktreePath = path.join(this.repoPath, ".worktrees", taskId);

    await mkdir(path.dirname(worktreePath), { recursive: true });
    await this.mustGit(["worktree", "add", "-b", branchName, worktreePath, startCommit], this.repoPath);

    return { branchName, baseBranch, worktreePath, startCommit };
  }

  async commitCheckpoint(worktreePath: string, message: string): Promise<string | undefined> {
    await this.mustGit(["add", "-A"], worktreePath);
    const status = await runCommand("git", ["status", "--porcelain"], { cwd: worktreePath });
    if (status.exitCode !== 0) {
      throw new Error(status.stderr || "git status failed");
    }
    if (!status.stdout.trim()) {
      return undefined;
    }

    const commit = await runCommand(
      "git",
      [
        "-c",
        "user.name=AI Workbench",
        "-c",
        "user.email=ai-workbench@local",
        "commit",
        "-m",
        message
      ],
      { cwd: worktreePath }
    );

    if (commit.exitCode !== 0) {
      throw new Error(commit.stderr || "git commit failed");
    }

    return this.getHeadCommit(worktreePath);
  }

  async rollbackTo(worktreePath: string, targetCommit: string): Promise<void> {
    await this.mustGit(["reset", "--hard", targetCommit], worktreePath);
    await this.mustGit(["clean", "-fd"], worktreePath);
  }

  async getDiffSummary(worktreePath: string): Promise<string> {
    const [stat, nameOnly] = await Promise.all([
      runCommand("git", ["diff", "--stat"], { cwd: worktreePath }),
      runCommand("git", ["diff", "--name-only"], { cwd: worktreePath })
    ]);

    const fileList = nameOnly.stdout
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20);

    return [stat.stdout.trim(), fileList.length ? `files: ${fileList.join(", ")}` : "files: none"]
      .filter(Boolean)
      .join("\n");
  }

  async publishTaskBranch(branchName: string, baseBranch: string): Promise<void> {
    await this.mustGit(["checkout", baseBranch], this.repoPath);
    const merge = await runCommand("git", ["merge", "--no-ff", branchName, "-m", `merge ${branchName}`], {
      cwd: this.repoPath
    });

    if (merge.exitCode !== 0) {
      throw new Error(merge.stderr || merge.stdout || "merge failed");
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await this.mustGit(["worktree", "remove", "--force", worktreePath], this.repoPath);
  }

  async getCurrentBranch(cwd: string): Promise<string> {
    const result = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "git rev-parse branch failed");
    }
    return result.stdout.trim();
  }

  async getHeadCommit(cwd: string): Promise<string> {
    const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "git rev-parse failed");
    }
    return result.stdout.trim();
  }

  private async mustGit(args: string[], cwd = this.repoPath): Promise<void> {
    const result = await runCommand("git", args, { cwd });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
    }
  }
}
