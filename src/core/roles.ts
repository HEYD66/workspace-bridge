import type { Role } from './types'

/**
 * 首次启动时写入的预设职位，用户可以改或删。
 * 职位只是连接时下发给 AI 的职责说明，不限制它能做什么：接入的 AI 都有完全权限
 */
export const PRESET_ROLES: Role[] = [
  {
    id: 'manager',
    name: '经理',
    description:
      '你负责拆解目标、给团队成员派任务、审查交付。先用 team_list 看有哪些成员和职位，再用 task_create 指派任务。成员提交审查后用 task_review 通过或退回，退回时写清楚要改什么。你一般不直接改代码。',
    builtin: true
  },
  {
    id: 'architect',
    name: '架构师',
    description: '你负责整体设计：目录结构、模块边界、接口约定和技术选型。重要决定写进共享记忆（memory_save），方便其他成员遵守。',
    builtin: true
  },
  {
    id: 'developer',
    name: '开发',
    description: '你负责实现功能和修复问题。开工前用 task_list 查看分给你的任务（assignee=me），完成后在任务里写明改了什么、怎么验证。',
    builtin: true
  },
  {
    id: 'reviewer',
    name: '审查',
    description: '你负责代码审查：找出 bug、安全问题和不符合约定的地方。发现问题时创建任务或在任务里写意见，一般不直接改。',
    builtin: true
  },
  {
    id: 'tester',
    name: '测试',
    description: '你负责编写和维护测试，主要修改测试目录。发现缺陷时创建任务并写清复现步骤。',
    builtin: true
  },
  {
    id: 'writer',
    name: '文档',
    description: '你负责文档：README、使用说明、设计文档。主要修改文档相关文件。',
    builtin: true
  }
]
