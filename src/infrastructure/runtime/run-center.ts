import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { id, nowIso, truncate } from "../../shared/utils.js";

type RunStatus = "Running" | "Stopped" | "Failed";
type ProjectType = "Vue3" | "React" | "Node" | "JavaMaven" | "JavaGradle" | "Unknown";

export interface RunInfo {
  id: string;
  cwd: string;
  command: string;
  projectType: ProjectType;
  recommendedCommand: string;
  status: RunStatus;
  pid?: number;
  startedAt: string;
  endedAt?: string;
}

interface RunState extends RunInfo {
  process?: ReturnType<typeof spawn>;
  logs: string;
}

export class RunCenter {
  private runs = new Map<string, RunState>();
  private maxLogChars = 120000;

  async detect(cwd: string): Promise<{ projectType: ProjectType; recommendedCommand: string }> {
    const packageJsonPath = path.join(cwd, "package.json");
    const pomPath = path.join(cwd, "pom.xml");
    const gradlePath = path.join(cwd, "build.gradle");
    const gradleKtsPath = path.join(cwd, "build.gradle.kts");

    if (await this.exists(pomPath)) {
      return { projectType: "JavaMaven", recommendedCommand: "mvn spring-boot:run" };
    }
    if ((await this.exists(gradlePath)) || (await this.exists(gradleKtsPath))) {
      return { projectType: "JavaGradle", recommendedCommand: "./gradlew bootRun" };
    }
    if (await this.exists(packageJsonPath)) {
      const raw = await readFile(packageJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
      const scripts = parsed.scripts ?? {};
      const deps = { ...(parsed.dependencies ?? {}) };
      const isVue = Boolean(deps.vue);
      const isReact = Boolean(deps.react);

      if (isVue) {
        if (scripts.dev) return { projectType: "Vue3", recommendedCommand: "npm run dev" };
        if (scripts.start) return { projectType: "Vue3", recommendedCommand: "npm run start" };
        return { projectType: "Vue3", recommendedCommand: "npm install && npm run dev" };
      }

      if (isReact) {
        if (scripts.dev) return { projectType: "React", recommendedCommand: "npm run dev" };
        if (scripts.start) return { projectType: "React", recommendedCommand: "npm run start" };
        return { projectType: "React", recommendedCommand: "npm install && npm run dev" };
      }

      if (scripts.dev) return { projectType: "Node", recommendedCommand: "npm run dev" };
      if (scripts.start) return { projectType: "Node", recommendedCommand: "npm run start" };
      return { projectType: "Node", recommendedCommand: "npm install && npm run start" };
    }

    return { projectType: "Unknown", recommendedCommand: "请手动输入启动命令" };
  }

  async start(cwd: string, command?: string): Promise<RunInfo> {
    const detected = await this.detect(cwd);
    const runCommand = command?.trim() || detected.recommendedCommand;
    if (!runCommand || runCommand.includes("请手动输入")) {
      throw new Error("无法自动确定启动命令，请手动输入后再启动。");
    }

    const runId = id("run");
    const startedAt = nowIso();
    const child = spawn("/bin/zsh", ["-lc", runCommand], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const state: RunState = {
      id: runId,
      cwd,
      command: runCommand,
      projectType: detected.projectType,
      recommendedCommand: detected.recommendedCommand,
      status: "Running",
      pid: child.pid,
      startedAt,
      logs: ""
    };
    state.process = child;
    this.runs.set(runId, state);

    child.stdout.on("data", (chunk) => this.appendLog(runId, chunk.toString()));
    child.stderr.on("data", (chunk) => this.appendLog(runId, chunk.toString()));

    child.on("close", (code) => {
      const latest = this.runs.get(runId);
      if (!latest) return;
      latest.status = code === 0 ? "Stopped" : "Failed";
      latest.endedAt = nowIso();
      latest.process = undefined;
      latest.pid = undefined;
      this.appendLog(runId, `\n[process exit code=${code ?? -1}]`);
    });

    child.on("error", (err) => {
      const latest = this.runs.get(runId);
      if (!latest) return;
      latest.status = "Failed";
      latest.endedAt = nowIso();
      latest.process = undefined;
      latest.pid = undefined;
      this.appendLog(runId, `\n[process error] ${err.message}`);
    });

    return this.toRunInfo(state);
  }

  async stop(runId: string): Promise<RunInfo> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`运行实例不存在：${runId}`);
    }

    if (!run.process || run.status !== "Running") {
      return this.toRunInfo(run);
    }

    run.process.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (run.process && run.status === "Running") {
      run.process.kill("SIGKILL");
    }

    run.status = "Stopped";
    run.endedAt = nowIso();
    run.process = undefined;
    run.pid = undefined;
    this.appendLog(runId, "\n[stopped by user]");

    return this.toRunInfo(run);
  }

  listRuns(): RunInfo[] {
    return [...this.runs.values()]
      .map((item) => this.toRunInfo(item))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getLogs(runId: string): { runId: string; logs: string } {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`运行实例不存在：${runId}`);
    }
    return { runId, logs: run.logs };
  }

  async detectUrl(runId: string): Promise<{ runId: string; url?: string }> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`运行实例不存在：${runId}`);
    }

    const logUrl = this.extractUrl(run.logs);
    if (logUrl) {
      return { runId, url: logUrl };
    }

    const ports = this.extractPorts(run.command);
    for (const port of ports) {
      const url = `http://127.0.0.1:${port}`;
      if (await this.isReachable(url)) {
        return { runId, url };
      }
    }
    return { runId };
  }

  async openUrl(url: string): Promise<void> {
    const target = url.trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new Error("URL 必须以 http:// 或 https:// 开头。");
    }
    const proc = spawn("open", [target], { stdio: "ignore", detached: true });
    proc.unref();
  }

  private appendLog(runId: string, chunk: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.logs += chunk;
    if (run.logs.length > this.maxLogChars) {
      run.logs = truncate(run.logs, this.maxLogChars);
    }
  }

  private toRunInfo(run: RunState): RunInfo {
    return {
      id: run.id,
      cwd: run.cwd,
      command: run.command,
      projectType: run.projectType,
      recommendedCommand: run.recommendedCommand,
      status: run.status,
      pid: run.pid,
      startedAt: run.startedAt,
      endedAt: run.endedAt
    };
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private extractUrl(text: string): string | undefined {
    const matches = text.match(/https?:\/\/[^\s"'`<>]+/g);
    return matches?.[matches.length - 1];
  }

  private extractPorts(command: string): number[] {
    const ports = new Set<number>();
    const direct = command.match(/(?:--port|-p)\s+(\d{2,5})/i);
    if (direct) {
      ports.add(Number(direct[1]));
    }
    [5173, 5174, 3000, 8080, 8000, 4200].forEach((p) => ports.add(p));
    return [...ports];
  }

  private async isReachable(url: string): Promise<boolean> {
    const client = url.startsWith("https://") ? https : http;
    return await new Promise<boolean>((resolve) => {
      const req = client.request(url, { method: "GET", timeout: 800 }, (res) => {
        resolve((res.statusCode ?? 500) < 500);
        req.destroy();
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }
}
