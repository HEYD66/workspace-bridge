import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityEvent, BridgeState, MemoryItem, SkillInfo, TaskItem } from '../../../shared/api'
import { errText } from './format'
import { skillViewWorkspace, useSkillWorkspace } from './skillScope'

const MAX_EVENTS = 1000
const EMPTY_SKILLS: SkillInfo[] = []

// .bridge/skills 下的文件，或整个 .bridge 目录被移动 / 删除；Windows 路径不分大小写
const SKILLS_PATH = /^(\.[\\/])?\.bridge([\\/]skills([\\/]|$)|[\\/]?$)/i

/** AI 用 install_skill 或直接写 .bridge/skills 下的文件时，主进程不一定发 'skills' 通知，靠活动事件补一次刷新 */
function touchesSkills(ev: ActivityEvent): boolean {
  if (ev.status === 'running') return false
  if (ev.tool === 'install_skill') return true
  return [ev.path, ev.args?.from, ev.args?.to].some((p) => typeof p === 'string' && SKILLS_PATH.test(p))
}

/** 订阅主进程推送的状态、活动事件，以及记忆、任务和技能（变化时自动重新拉取） */
export function useBridge() {
  const [state, setState] = useState<BridgeState | null>(null)
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillsError, setSkillsError] = useState<string>()
  const skillsSeq = useRef(0)
  // 技能页看哪个工作区的技能（undefined = 当前工作区）。skills 是这个工作区的列表，skillsOf 记着它是哪个工作区的：
  // 刚换工作区、新列表还没到时，界面不能把上一个工作区的列表当成这个工作区的
  const skillWs = skillViewWorkspace(useSkillWorkspace(), state ?? { workspaces: [] })
  const skillWsRef = useRef(skillWs)
  skillWsRef.current = skillWs
  const [skillsOf, setSkillsOf] = useState<string>()

  // 「整台电脑」的任务板：工作台切不到整台电脑，任务页另外拉它的任务（当前工作区的在 tasks 里）
  const [machineTasks, setMachineTasks] = useState<TaskItem[]>([])
  const machineId = state?.workspaces.find((w) => w.kind === 'machine')?.id
  const machineIdRef = useRef(machineId)
  machineIdRef.current = machineId

  const reloadMemories = useCallback(() => window.bridge.listMemories().then(setMemories), [])
  const reloadTasks = useCallback(() => {
    const id = machineIdRef.current
    if (id) void window.bridge.listTasks(id).then((list) => machineIdRef.current === id && setMachineTasks(list))
    return window.bridge.listTasks().then(setTasks)
  }, [])
  // 状态到了才知道整台电脑的 id，那时补拉一次
  useEffect(() => {
    if (machineId) void reloadTasks()
  }, [machineId, reloadTasks])
  // 拉取失败保留上次的列表，只记下错误给界面显示；只认最后一次请求的结果。
  // 列表是技能页正在看的那个工作区的（skillWs，不给 = 当前工作区）
  const reloadSkills = useCallback(async () => {
    const n = ++skillsSeq.current
    const ws = skillWsRef.current
    try {
      const list = await window.bridge.listSkills(ws)
      if (n !== skillsSeq.current) return
      setSkills(Array.isArray(list) ? list : [])
      setSkillsOf(ws)
      setSkillsError(undefined)
    } catch (e) {
      if (n === skillsSeq.current) setSkillsError(errText(e))
    }
  }, [])
  // 技能页换了要看的工作区：重新拉
  useEffect(() => {
    if (state) void reloadSkills()
    // 只在 skillWs 变的时候拉；state 每次推送都变，不能放进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillWs, reloadSkills])

  useEffect(() => {
    let alive = true
    void window.bridge.getState().then((s) => alive && setState(s))
    void window.bridge.getEvents().then((e) => alive && setEvents(e))
    void reloadMemories()
    void reloadTasks()
    void reloadSkills()
    const offState = window.bridge.onState(setState)
    const offChanged = window.bridge.onChanged((kind) => {
      if (kind === 'memory') void reloadMemories()
      else if (kind === 'tasks') void reloadTasks()
      else if (kind === 'skills') void reloadSkills()
    })
    const offEvent = window.bridge.onEvent((ev) => {
      setEvents((prev) => {
        // 同一个 id 先 running 后 ok/error，从尾部找（通常就是最后几条）
        for (let i = prev.length - 1; i >= Math.max(0, prev.length - 200); i--) {
          if (prev[i].id === ev.id) {
            const next = prev.slice()
            next[i] = ev
            return next
          }
        }
        const next = [...prev, ev]
        return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next
      })
      if (touchesSkills(ev)) void reloadSkills()
    })
    return () => {
      alive = false
      offState()
      offEvent()
      offChanged()
    }
  }, [reloadMemories, reloadTasks, reloadSkills])

  const skillsLoading = skillsOf !== skillWs
  return {
    state,
    events,
    memories,
    tasks,
    machineTasks,
    /** 技能页正在看的工作区的技能；刚换工作区、新列表还没到时是空的（skillsLoading 为 true） */
    skills: skillsLoading ? EMPTY_SKILLS : skills,
    skillsLoading,
    skillsError,
    /** 技能页正在看的工作区：undefined = 当前工作区，否则是别的工作区的 id */
    skillWs,
    reloadSkills
  }
}
