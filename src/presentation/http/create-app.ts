import express from "express";
import cors from "cors";
import path from "node:path";
import { z } from "zod";
import { Orchestrator } from "../../application/orchestrator.js";
import { parseRoleInput } from "../../domain/roles.js";
import { DEFAULT_TASK_PRESET } from "../../domain/task-presets.js";
import type { Role } from "../../domain/types.js";
import { ArtifactStore } from "../../infrastructure/artifacts/artifact-store.js";
import { CodexExecutor } from "../../infrastructure/execution/codex-executor.js";
import { RunCenter } from "../../infrastructure/runtime/run-center.js";
import { SQLiteStore } from "../../infrastructure/store/sqlite-store.js";

const taskInputSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  constraints: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  repoPath: z.string().optional(),
  budgetPolicy: z
    .object({
      hardLimit: z.number().positive().optional(),
      softLimit: z.number().positive().optional(),
      fallbackModel: z.string().optional(),
      circuitBreakerAt: z.number().positive().optional()
    })
    .optional()
});

const roleSchema = z
  .string()
  .min(1)
  .transform((value) => parseRoleInput(value))
  .refine((value): value is Role => Boolean(value), { message: "无效角色，请使用中文角色名或系统角色ID。" });

const approvalSchema = z.object({
  decision: z.enum(["Approve", "Reject", "Rework"]),
  reason: z.string().optional()
});

const retrySchema = z.object({
  role: roleSchema.optional()
});

const rollbackSchema = z.object({
  mode: z.enum(["AutoToCheckpoint", "ManualSelectCommit"]),
  targetCommit: z.string().optional()
});

const messageSchema = z.object({
  role: roleSchema,
  content: z.string().min(1)
});

const detectSchema = z.object({
  taskId: z.string().optional(),
  cwd: z.string().optional()
});

const startRunSchema = z.object({
  taskId: z.string().optional(),
  cwd: z.string().optional(),
  command: z.string().optional()
});

const stopRunSchema = z.object({
  runId: z.string().min(1)
});

const openUrlSchema = z.object({
  url: z.string().min(1)
});

export function createApp(repoPath: string): express.Express {
  const store = new SQLiteStore(path.join(repoPath, ".ai-workbench", "workbench.db"));
  const executor = new CodexExecutor();
  const artifacts = new ArtifactStore(repoPath);
  const runCenter = new RunCenter();
  const defaultTaskRepoPath = path.join(repoPath, ".ai-workbench", "runtime-repos", "default");
  const orchestrator = new Orchestrator(store, defaultTaskRepoPath, executor, artifacts);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/tasks", (_req, res) => {
    res.json(orchestrator.listTasks());
  });

  app.get("/presets/defaults", (_req, res) => {
    res.json(DEFAULT_TASK_PRESET);
  });

  app.post("/tasks", async (req, res, next) => {
    try {
      const input = taskInputSchema.parse(req.body);
      const task = await orchestrator.createTask(input);
      res.status(201).json(task);
    } catch (error) {
      next(error);
    }
  });

  app.get("/tasks/:id", (req, res, next) => {
    try {
      const task = orchestrator.getTask(req.params.id);
      res.json(task);
    } catch (error) {
      next(error);
    }
  });

  app.get("/tasks/:id/timeline", (req, res, next) => {
    try {
      const task = orchestrator.getTask(req.params.id);
      res.json(task.events);
    } catch (error) {
      next(error);
    }
  });

  app.post("/tasks/:id/roles/:role/run", async (req, res, next) => {
    try {
      const role = roleSchema.parse(req.params.role);
      const execution = await orchestrator.runRole(req.params.id, role);
      res.json(execution);
    } catch (error) {
      next(error);
    }
  });

  app.post("/tasks/:id/approve", async (req, res, next) => {
    try {
      const input = approvalSchema.parse(req.body);
      const task = await orchestrator.approve(req.params.id, input);
      res.json(task);
    } catch (error) {
      next(error);
    }
  });

  app.post("/tasks/:id/retry", async (req, res, next) => {
    try {
      const input = retrySchema.parse(req.body ?? {});
      const execution = await orchestrator.retry(req.params.id, input);
      res.json(execution);
    } catch (error) {
      next(error);
    }
  });

  app.post("/tasks/:id/rollback", async (req, res, next) => {
    try {
      const input = rollbackSchema.parse(req.body);
      const task = await orchestrator.rollback(req.params.id, input);
      res.json(task);
    } catch (error) {
      next(error);
    }
  });

  app.get("/tasks/:id/executions", (req, res, next) => {
    try {
      const rows = orchestrator.getExecutions(req.params.id);
      res.json(rows);
    } catch (error) {
      next(error);
    }
  });

  app.get("/tasks/:id/messages", (req, res, next) => {
    try {
      res.json(orchestrator.getMessages(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post("/chat/:taskId/message", (req, res, next) => {
    try {
      const input = messageSchema.parse(req.body);
      const message = orchestrator.addMessage(req.params.taskId, input.role, input.content);
      res.status(201).json(message);
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifacts/:taskId", (req, res, next) => {
    try {
      const executions = orchestrator.getExecutions(req.params.taskId);
      const task = orchestrator.getTask(req.params.taskId);
      const artifacts = executions
        .filter((item) => item.status === "Succeeded")
        .map((item) => ({
          role: item.role,
          status: item.status,
          reviewStatus: item.reviewStatus,
          attempt: item.attempt,
          endedAt: item.endedAt,
          promptVersion: item.promptVersion,
          checkpointCommit: item.checkpointCommit,
          artifactPath: item.artifactPath,
          diffSummary: item.diffSummary,
          output: item.stdout || item.stderr || ""
        }));

      res.json({ taskId: task.id, artifacts });
    } catch (error) {
      next(error);
    }
  });

  app.post("/models/route-test", (_req, res) => {
    res.json({
      provider: "codex-cli",
      status: "ok",
      executable: "codex",
      note: "This deployment uses Codex CLI as the primary execution engine."
    });
  });

  app.get("/run-center/detect", async (req, res, next) => {
    try {
      const query = detectSchema.parse(req.query);
      let cwd = defaultTaskRepoPath;
      if (query.taskId) {
        const task = orchestrator.getTask(query.taskId);
        cwd = task.worktreePath;
      } else if (query.cwd) {
        cwd = path.resolve(query.cwd);
      }

      const detected = await runCenter.detect(cwd);
      res.json({ cwd, ...detected });
    } catch (error) {
      next(error);
    }
  });

  app.get("/run-center/runs", (_req, res) => {
    res.json(runCenter.listRuns());
  });

  app.get("/run-center/logs/:runId", (req, res, next) => {
    try {
      res.json(runCenter.getLogs(req.params.runId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/run-center/detect-url/:runId", async (req, res, next) => {
    try {
      const result = await runCenter.detectUrl(req.params.runId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/run-center/start", async (req, res, next) => {
    try {
      const input = startRunSchema.parse(req.body ?? {});
      let cwd = defaultTaskRepoPath;
      if (input.taskId) {
        const task = orchestrator.getTask(input.taskId);
        cwd = task.worktreePath;
      } else if (input.cwd) {
        cwd = path.resolve(input.cwd);
      }

      const run = await runCenter.start(cwd, input.command);
      res.status(201).json(run);
    } catch (error) {
      next(error);
    }
  });

  app.post("/run-center/stop", async (req, res, next) => {
    try {
      const input = stopRunSchema.parse(req.body);
      const run = await runCenter.stop(input.runId);
      res.json(run);
    } catch (error) {
      next(error);
    }
  });

  app.post("/run-center/open", async (req, res, next) => {
    try {
      const input = openUrlSchema.parse(req.body);
      await runCenter.openUrl(input.url);
      res.json({ ok: true, url: input.url });
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(path.join(repoPath, "public")));

  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(repoPath, "public", "index.html"));
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ message: "请求参数不正确", issues: error.issues });
      return;
    }

    if (error instanceof Error) {
      res.status(400).json({ message: error.message });
      return;
    }

    res.status(500).json({ message: "服务端未知错误" });
  });

  return app;
}
