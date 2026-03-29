# AI 工作台（Codex CLI 主引擎）

本项目是一个本地优先的 AI 研发工作台，默认使用 **Codex CLI** 作为主要执行引擎。

## 已实现能力

- Web 工作台：任务创建、角色执行、PM 审批与回滚操作
- 编排器（Orchestrator）：六角色流程编排  
  `Architect`、`Designer`、`SeniorDeveloper`、`QA`、`Ops`、`PM`
- Codex 执行适配层：统一命令协议、超时控制、重试判断
- 全链路审计：命令、状态、输出摘要、差异摘要、成本估算
- Git 工作隔离：每任务独立 `worktree`
- 阶段检查点：阶段成功后自动提交 checkpoint
- 自动回滚：失败/驳回时回滚到指定检查点
- PM 强制门禁：`Approve` / `Reject` / `Rework`

## 快速启动

```bash
npm install
npm run dev
```

启动后访问：`http://localhost:7788`

## 环境变量

- `PORT`：服务端口，默认 `7788`
- `REPO_PATH`：目标仓库路径，默认当前目录
- `MOCK_CODEX=1`：开启 Codex 模拟执行模式（测试场景使用）

## 核心接口

- `POST /tasks`：创建任务并初始化 worktree
- `POST /tasks/:id/roles/:role/run`：触发角色执行（Codex CLI）
- `POST /tasks/:id/approve`：PM 审批决策
- `POST /tasks/:id/retry`：重试当前/指定角色节点
- `POST /tasks/:id/rollback`：任务回滚（自动/手动）
- `GET /tasks/:id/executions`：查看执行审计记录
- `GET /tasks/:id/timeline`：查看时间线与决策链路
- `POST /chat/:taskId/message`：角色协作消息写入
- `GET /artifacts/:taskId`：查看成功阶段产物摘要
- `POST /models/route-test`：执行引擎健康检查（Codex）

## 测试

```bash
npm test
```

## 说明

- 当前版本为单用户、本地优先。
- 执行引擎为 Codex CLI，不走多厂商模型 API 直连路由。
- 任务分支命名规则：`task/<taskId>`，对应工作目录：`.worktrees/<taskId>`。

## 文档规范

- 仓库内项目文档统一使用 **UTF-8 编码**。
- 新增文档默认使用 **中文**（除非你明确指定英文版）。
