import express from "express";
import cors from "cors";
import path from "node:path";
import { z } from "zod";
import { InMemoryStore } from "./store.js";
import { GitService } from "./git.js";
import { CodexExecutor } from "./codex-executor.js";
import { Orchestrator } from "./orchestrator.js";
import type { Role } from "./types.js";

const taskInputSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  constraints: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  budgetPolicy: z
    .object({
      hardLimit: z.number().positive().optional(),
      softLimit: z.number().positive().optional(),
      fallbackModel: z.string().optional(),
      circuitBreakerAt: z.number().positive().optional()
    })
    .optional()
});

const roleSchema = z.enum(["PM", "Architect", "Designer", "SeniorDeveloper", "QA", "Ops"]);

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
  role: z.union([roleSchema, z.literal("PM")]),
  content: z.string().min(1)
});

export function createApp(repoPath: string): express.Express {
  const store = new InMemoryStore();
  const git = new GitService(repoPath);
  const executor = new CodexExecutor();
  const orchestrator = new Orchestrator(store, git, executor);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/tasks", (_req, res) => {
    res.json(orchestrator.listTasks());
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
      const role = roleSchema.parse(req.params.role) as Role;
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
          promptVersion: item.promptVersion,
          checkpointCommit: item.checkpointCommit,
          diffSummary: item.diffSummary,
          outputPreview: item.stdout.slice(0, 200)
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

  app.use(express.static(path.join(repoPath, "public")));

  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(repoPath, "public", "index.html"));
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ message: "Invalid request", issues: error.issues });
      return;
    }

    if (error instanceof Error) {
      res.status(400).json({ message: error.message });
      return;
    }

    res.status(500).json({ message: "Unknown server error" });
  });

  return app;
}
