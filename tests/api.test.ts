import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/presentation/http/create-app.js";
import { CodexExecutor } from "../src/infrastructure/execution/codex-executor.js";

describe("AI Workbench API", () => {
  let app: ReturnType<typeof createApp>;
  let repoDir: string;

  beforeEach(async () => {
    process.env.MOCK_CODEX = "1";
    repoDir = await mkdtemp(path.join(os.tmpdir(), "ai-workbench-"));
    await writeFile(path.join(repoDir, "README.md"), "# sandbox\n");
    app = createApp(repoDir);
  });

  it(
    "creates task in internal managed project workspace",
    async () => {
      const created = await request(app)
        .post("/tasks")
        .send({ title: "Build feature", goal: "deliver MVP" })
        .expect(201);

      expect(created.body.id).toBeTruthy();
      expect(created.body.projectId).toBe("default");
      expect(created.body.projectName).toBe("默认托管项目");
      expect(created.body.projectRepoPath).toContain(path.join(".ai-workbench", "projects", "default", "repo"));
      expect(created.body.projectBranchName).toContain("task/");
      expect(created.body.projectBaseBranch).toBe("master");
      expect(created.body.worktreePath).toContain(".worktrees");
      expect(created.body.status).toBe("InProgress");
    },
    15000
  );

  it(
    "runs role execution then waits for PM approval",
    async () => {
      const created = await request(app)
        .post("/tasks")
        .send({ title: "Build feature", goal: "deliver MVP" })
        .expect(201);

      const taskId = created.body.id;
      const roleResult = await request(app).post(`/tasks/${taskId}/roles/Architect/run`).send({}).expect(200);

      expect(roleResult.body.status).toBe("Succeeded");

      const task = await request(app).get(`/tasks/${taskId}`).expect(200);
      expect(task.body.status).toBe("WaitingPM");

      const approved = await request(app)
        .post(`/tasks/${taskId}/approve`)
        .send({ decision: "Approve" })
        .expect(200);

      expect(approved.body.currentRoleIndex).toBe(1);
    },
    15000
  );

  it(
    "supports PM reject with rollback event",
    async () => {
      const created = await request(app)
        .post("/tasks")
        .send({ title: "Build feature", goal: "deliver MVP" })
        .expect(201);

      const taskId = created.body.id;
      await request(app).post(`/tasks/${taskId}/roles/Architect/run`).send({}).expect(200);

      const rejected = await request(app)
        .post(`/tasks/${taskId}/approve`)
        .send({ decision: "Reject", reason: "Need better UX" })
        .expect(200);

      expect(rejected.body.status).toBe("Rejected");

      const timeline = await request(app).get(`/tasks/${taskId}/timeline`).expect(200);
      expect(timeline.body.some((entry: { type: string }) => entry.type === "Rollback")).toBe(true);
    },
    15000
  );

  it(
    "marks failed execution attempt as failed",
    async () => {
      const executeSpy = vi.spyOn(CodexExecutor.prototype, "execute").mockResolvedValueOnce({
        command: "codex exec <mock>",
        status: "Failed",
        stdout: "",
        stderr: "cli error",
        exitCode: 1,
        durationMs: 10,
        estimatedCost: 0.001,
        retriable: false
      });

      try {
        const created = await request(app)
          .post("/tasks")
          .send({ title: "Build feature", goal: "deliver MVP" })
          .expect(201);

        const taskId = created.body.id;
        const roleResult = await request(app).post(`/tasks/${taskId}/roles/Architect/run`).send({}).expect(200);
        expect(roleResult.body.status).toBe("Failed");

        const executions = await request(app).get(`/tasks/${taskId}/executions`).expect(200);
        expect(executions.body).toHaveLength(1);
        expect(executions.body[0].status).toBe("Failed");

        const task = await request(app).get(`/tasks/${taskId}`).expect(200);
        expect(task.body.status).toBe("Blocked");
      } finally {
        executeSpy.mockRestore();
      }
    },
    15000
  );
});
