// 外壳（图标栏 + 齿轮菜单）的纯逻辑。
// 11-15 之前别的页面都收在「更多」菜单里；用户说把里面的东西拿出来：干活用的放图标栏，管理和配置用的放设置（齿轮点开的菜单，照 Codex）
import type { Section } from './nav'

/**
 * 图标栏上常驻的分区，按这个顺序排。首页后面是画布（11-16 加的：所有项目和 AI 画在一张图上），然后是原来就在的任务、定时任务，后五个是从「更多」里拿出来的干活用的页面。
 * RAIL_DIVIDER_AFTER 之后画一条分隔线
 */
export const RAIL_SECTIONS: readonly Section[] = ['overview', 'canvas', 'tasks', 'schedules', 'chat', 'files', 'search', 'changes', 'commands']
export const RAIL_DIVIDER_AFTER: Section = 'schedules'

/** 齿轮菜单里的分区，按这个顺序列：设置本身，然后是管理和配置用的页面。每一组之间画一条线 */
export const SETTINGS_GROUPS: readonly (readonly Section[])[] = [['settings'], ['team', 'memory', 'skills'], ['playground', 'audit']]
export const SETTINGS_SECTIONS: readonly Section[] = SETTINGS_GROUPS.flat()

export const isSettingsSection = (s: Section): boolean => SETTINGS_SECTIONS.includes(s)

/**
 * 图标栏上现在该画哪些分区：常驻的几个；正在看的页面既不在栏上、也不在齿轮菜单里（现在只有单独的「群聊」页：
 * 点通知、从任务板跳过去会到那里），就把它临时加在后面，不然图标栏上没有一个是亮的
 */
export function railSections(current: Section): Section[] {
  return RAIL_SECTIONS.includes(current) || isSettingsSection(current) ? [...RAIL_SECTIONS] : [...RAIL_SECTIONS, current]
}

/** 标签里括号中的说明拆出来：'文件（Ctrl+Shift+E）' → { text: '文件', hint: 'Ctrl+Shift+E' } */
export function splitLabel(label: string): { text: string; hint?: string } {
  const m = /^(.*?)（(.*)）$/.exec(label.trim())
  return m ? { text: m[1].trim(), hint: m[2].trim() } : { text: label.trim() }
}
