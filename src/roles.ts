import type { ArtifactType, Role } from "./types.js";

export interface RoleContract {
  role: Role;
  promptVersion: string;
  timeoutSec: number;
  defaultRetries: number;
  artifactType: ArtifactType;
  systemPrompt: string;
}

export const ROLE_CHAIN: Role[] = ["Architect", "Designer", "SeniorDeveloper", "QA", "Ops", "PM"];

export const ROLE_CONTRACTS: Record<Role, RoleContract> = {
  PM: {
    role: "PM",
    promptVersion: "pm.v1",
    timeoutSec: 120,
    defaultRetries: 0,
    artifactType: "ReleaseNote",
    systemPrompt:
      "你是产品经理最终体验官，评审交付物是否满足用户目标。你可以通过、驳回或要求重做，并给出明确理由。"
  },
  Architect: {
    role: "Architect",
    promptVersion: "architect.v1",
    timeoutSec: 240,
    defaultRetries: 2,
    artifactType: "ArchSpec",
    systemPrompt:
      "你是架构师，输出可实现、可测试、可演进的方案，明确模块边界、接口、失败处理。"
  },
  Designer: {
    role: "Designer",
    promptVersion: "designer.v1",
    timeoutSec: 240,
    defaultRetries: 2,
    artifactType: "UIDesign",
    systemPrompt:
      "你是产品设计师，输出以用户体验为中心的交互与视觉规范，兼顾桌面和移动端。"
  },
  SeniorDeveloper: {
    role: "SeniorDeveloper",
    promptVersion: "senior-dev.v1",
    timeoutSec: 420,
    defaultRetries: 2,
    artifactType: "CodePatch",
    systemPrompt:
      "你是高级开发，交付可运行代码、必要测试与变更说明，优先保证稳定性和可维护性。"
  },
  QA: {
    role: "QA",
    promptVersion: "qa.v1",
    timeoutSec: 240,
    defaultRetries: 2,
    artifactType: "TestReport",
    systemPrompt:
      "你是测试工程师，验证功能、回归与边界场景，输出可复现步骤和结论。"
  },
  Ops: {
    role: "Ops",
    promptVersion: "ops.v1",
    timeoutSec: 240,
    defaultRetries: 2,
    artifactType: "Runbook",
    systemPrompt:
      "你是运维工程师，输出部署/回滚手册、监控项、告警阈值与发布检查清单。"
  }
};
