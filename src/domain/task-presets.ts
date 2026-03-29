import type { BudgetPolicy } from "./types.js";

export interface TaskPreset {
  constraints: string[];
  acceptanceCriteria: string[];
  budgetPolicy: BudgetPolicy;
}

export const DEFAULT_TASK_PRESET: TaskPreset = {
  constraints: [
    "仅修改与当前任务相关的文件，不做无关重构。",
    "单角色最多执行 1 轮；若失败最多自动重试 2 次。",
    "单次执行超过角色超时时间立即停止并记录原因。",
    "禁止删除核心入口与配置文件；高风险改动需要给出说明。",
    "输出必须包含变更摘要和验证结果。",
    "遇到需求不明确时先停下并等待产品经理确认。"
  ],
  acceptanceCriteria: [
    "主流程可用，且不破坏现有核心流程。",
    "构建通过：npm run build 成功。",
    "测试通过：npm test 成功。",
    "关键交互文案清晰，页面可在桌面和移动端正常显示。",
    "失败时可回滚到最近检查点。"
  ],
  budgetPolicy: {
    hardLimit: 20,
    softLimit: 10,
    fallbackModel: "gpt-5.4-mini",
    circuitBreakerAt: 20
  }
};

