/**
 * 手机端 → 手表端 同步接口层
 *
 * 对端应用：手机端课程表（包名 com.haooz.chedule，组包见其 wearable/WatchPayload.kt）
 * 主通道：@system.interconnect（小米穿戴 MessageApi ↔ 手表 @system.interconnect）
 * 本地缓存：@system.storage —— 冷启动 / 断开手机后仍可查看上次同步的课表
 *
 * 手表端覆盖策略（不改手机端也能看更多天的关键）：
 *   1. 按日期直推（v3，手机只推「今天 ±14 天」窗口）→ **合并累积**，不替换旧日期；
 *   2. 整周分桶（v1/v2，只含推送那一刻的当前教学周）→ 按周**归档**，历史周不被顶掉；
 *   3. 整表（version=4，手机端 WatchPayload.buildFullJson）→ 手环按周一起算公式自行推算任意一周。
 *   查看某天的优先级：按日期条目 > 周归档 > 整表推算 > 最新周快照。
 *
 * ---------------------------------------------------------------------------
 * 协议（以手机端 WatchPayload.buildWeekJson 为准）
 * ---------------------------------------------------------------------------
 * {
 *   "protocol": "nexio.schedule",
 *   "version": 1,                  // 手机端组包时的协议版本（1 或 2 都支持）
 *   "action": "replace",           // replace=整周覆盖 | upsert=按天合并 | clear=清空
 *   "sentAt": 1760000000000,
 *   "scheduleName": "默认课表",
 *   "week": { "0": [ ... ], ..., "6": [ ... ] },   // 键 0-6（手表域）或 1-7（手机域）都认
 *   "holidays": [                                  // HolidayManager.Entry[]
 *     { "date": "2026-10-01", "endDate": "2026-10-07", "name": "国庆节",
 *       "type": 0, "followWeek": -1, "followWeekday": -1, "custom": false },
 *     { "date": "2026-10-10", "endDate": "", "name": "补班",
 *       "type": 1, "followWeek": 6, "followWeekday": 1, "custom": false }
 *   ]
 * }
 *
 * 课程字段：{ id, name, startTime, endTime, periods, location, teacher }
 *
 * 星期编号的两个域不需要靠 version 判断（周一到周六 1-6 完全相同，只有周日不同）：
 *   手表域 0=周日..6=周六；手机域 1=周一..7=周日。
 * 单个键看到 0 或 7 就知道是周日，看到 1-6 就是周一到周六 —— 见 weekKeyToInternal。
 * 因此 version=1(0-6)、version=2(1-7)，甚至版本号变了但键沿用 0-6，都能正确解析，
 * 不会出现「周一~周六整体错位一天」。version 只用于日志诊断。
 * holidays[].followWeekday 为手机域 1-7（1=周一 .. 7=周日），0 与 7 都按周日容错处理。
 *
 * 手表端主动要数据（**手动接口**，正常被动模式下不发送；手机端
 * WearableScheduleSync 收到 request 就整包推送，它只校验 protocol / action）：
 * { "protocol": "nexio.schedule", "version": 2, "action": "request", "reason": "app-open" }
 *
 * 读取频率：**轮询 + 事件触发**拉取 —— 启动、onShow（数据过期/通道未就绪）、
 * 通道重连、缺按日期数据时立即拉取，另有每 POLL_INTERVAL_MS 一次的定时轮询兜底；
 * 手机端点「推送到手环」仍是主要数据入口（轮询拉回的也是同一个整表包）。
 *
 * 注意：interconnect 要求手表 rpk 与手机 App 包名、签名一致。
 */

import interconnect from '@system.interconnect'
import storage from '@system.storage'
import prompt from '@system.prompt'
import schedule from './schedule'

const PROTOCOL = 'nexio.schedule'
/** 向手机端发请求时带的协议版本（与最新手机端对齐；解析侧对 1/2/未知版本都兼容） */
const PROTOCOL_VERSION = 2
/** 支持的 wire 版本（仅用于日志：键的编号域由键自身决定，见 weekKeyToInternal） */
const SUPPORTED_WIRE_VERSIONS = [1, 2, 3, 4]
/**
 * 本地缓存的内部版本号：缓存里的 week 键已经归一化成手表域 0-6，
 * 读回时命中它就不再做 wire 换算（缓存是本模块自己写的，格式由本文件保证）。
 */
const CACHE_VERSION = 0
const STORAGE_KEY = 'nexio.schedule.payload'

const ACTION = {
  REPLACE: 'replace',
  UPSERT: 'upsert',
  CLEAR: 'clear',
  REQUEST: 'request',
  ACK: 'ack'
}

/** 手机端包名（interconnect 对端；两端 package 必须一致） */
const PEER_PACKAGE = 'com.haooz.chedule'

const listeners = []
/** 页面级 toast 监听（连接提示等 UI 事件），见 onToast */
const toastListeners = []
let connect = null
let ready = false
let lastError = null
let cachedQuote = ''
/** 已应用的最新同步序号 */
let appliedRev = 0
/** 主动请求同步的最小间隔，避免 onShow/重试把通道刷爆 */
const REQUEST_MIN_GAP_MS = 15000
/** 手动 requestSync 后多久没收到数据就重试，以及最多重试几次（仅手动路径使用） */
const RETRY_DELAY_MS = 4000
const MAX_RETRY = 2
/** 本地数据超过这个时间就认为过期，页面 onShow 时主动向手机要一次 */
const STALE_MS = 5 * 60 * 1000
/** 「按日期直推」数据的请求节流（v2/v3 用户兜底补数据用） */
const NEED_DATED_MIN_GAP_MS = 60000
/** 定时轮询间隔：整表包不大，5 分钟一次足以自愈，又不会明显耗电 */
const POLL_INTERVAL_MS = 5 * 60 * 1000

/** 本地缓存时间戳（0 表示当前进程还没有可用缓存） */
let cachedAt = 0
/** 同步诊断（关于页「同步诊断」展示）：最近一次数据的来源、形态、时间 */
let lastSource = ''
let lastShape = ''
let lastAt = 0
/** 请求节流 / 重试状态 */
let lastRequestAt = 0
let retryTimer = null
let retryCount = 0
/** 定时轮询句柄 */
let pollTimer = null
/** 本次连接是否已弹过「已连接手机」toast（断开后重置，重连才再弹） */
let connectNotified = false

/** 通道接通时提示一次「已连接手机」；重复触发（onopen 与 getReadyState 都报告就绪）不重复弹 */
function notifyConnected() {
  if (connectNotified) return
  connectNotified = true
  let delivered = false
  for (let i = 0; i < toastListeners.length; i++) {
    try {
      toastListeners[i]('已连接手机')
      delivered = true
    } catch (e) {
      console.log('[sync] toast listener error', e)
    }
  }
  // 页面还没挂监听（理论上不会发生）时退回系统 toast（居中，仅兜底）
  if (!delivered) {
    try {
      prompt.showToast({ message: '已连接手机', duration: 2000 })
    } catch (e) {
      console.log('[sync] showToast fail', e)
    }
  }
}
/** 缺「按日期直推」数据的请求节流与次数（诊断用） */
let lastNeedDatedAt = 0
let needDatedCount = 0

function notify() {
  for (let i = 0; i < listeners.length; i++) {
    try {
      listeners[i]()
    } catch (e) {
      console.log('[sync] listener error', e)
    }
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function parseMessage(raw) {
  if (raw == null) return null
  if (typeof raw === 'string') {
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch (e) {
      lastError = 'invalid json'
      return null
    }
  }
  // interconnect onmessage 回调可能包一层 { data: '...' }
  if (isPlainObject(raw) && typeof raw.data === 'string' && raw.protocol == null) {
    return parseMessage(raw.data)
  }
  return isPlainObject(raw) ? raw : null
}

/**
 * storage.get 的 success 按文档直接给字符串；
 * 部分实现会包一层 { key, value } / { data }，这里统一拆出来。
 */
function readStoredValue(data) {
  if (data == null) return ''
  if (typeof data === 'string') return data
  if (isPlainObject(data)) {
    if (typeof data.value === 'string') return data.value
    if (typeof data.data === 'string') return data.data
  }
  return ''
}

/**
 * week 键 → 手表内部 week key(0-6)。
 *
 * 手机域（1=周一..7=周日）与手表域（0=周日..6=周六）只在「周日」不同：
 * 周一到周六两个域都是 1-6，周日则是 0（手表域）或 7（手机域）。
 * 因此单个键本身就能自我描述，不需要依赖 version：
 *   0 或 7 → 周日(0)；1..6 → 原值；其余非法。
 * 这样 v1(0-6)、v2(1-7)，甚至 v2 沿用 0-6 键都能正确解析，
 * 且对已归一化的缓存数据是幂等的（0-6 再映射一次还是 0-6）。
 */
function weekKeyToInternal(key) {
  const n = parseInt(key, 10)
  if (isNaN(n)) return -1
  if (n === 0 || n === 7) return 0
  return n >= 1 && n <= 6 ? n : -1
}

/**
 * 由日期字符串推手表内部星期(0-6)，失败返回 -1。
 * 注意：ISO 纯日期串（如 "2026-10-08"）会被 Date 按 UTC 午夜解析，
 * 而 getDay() 按本地时区求值，负时区下会退回前一天。
 * 故这里显式按 YYYY-MM-DD 构造本地时间，与手机端「今日」页保持同一天。
 */
function internalWeekdayFromDate(dateStr) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateStr || ''))
  let d
  if (m) {
    d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
  } else {
    d = new Date(dateStr)
  }
  if (isNaN(d.getTime())) return -1
  return d.getDay()
}

function num(v) {
  const n = parseInt(v, 10)
  return isNaN(n) ? 0 : n
}

function normalizeCourse(item, index, dayKey) {
  if (!isPlainObject(item)) return null
  const name = item.name || item.courseName || item.title || ''
  if (!name) return null
  const startTime = item.startTime || item.start || ''
  const endTime = item.endTime || item.end || ''
  const startSection = num(item.startSection)
  const endSection = num(item.endSection)
  const periods = item.periods || item.period || item.sectionText || ''
  // 有名字就是真课：手机端个别课解析不出时间（CourseTimeResolver 返回空）时
  // startTime/endTime 都可能是空串，过去在这里被整条丢弃 —— 表现为「偶尔缺课」。
  // 只要还带着节次文案（periods）就保留，界面至少显示课名/教室/节次。
  if (!startTime && !endTime && !startSection && !endSection && !periods) return null

  const location = item.location || item.place || item.classroom || ''
  const teacher = item.teacher || item.instructor || ''
  const section = schedule.resolveSection(item.section, startTime)

  let id = item.id != null ? String(item.id) : ''
  if (!id) {
    id = dayKey + '-' + (startTime ? startTime.replace(':', '') : startSection) + '-' + index
  }

  const out = {
    id: id,
    name: name,
    startTime: startTime,
    endTime: endTime,
    periods: periods,
    location: location,
    teacher: teacher,
    section: section
  }
  if (startSection || endSection) {
    out.startSection = startSection
    out.endSection = endSection
  }
  if (item.isCustomTime != null || item.customStartTime || item.customEndTime) {
    out.isCustomTime = !!item.isCustomTime
    out.customStartTime = item.customStartTime || ''
    out.customEndTime = item.customEndTime || ''
  }
  // v2 可能在桶里带上每门课的周次规则（表示「没按当前周过滤」）
  if (
    item.weekType != null ||
    item.startWeek != null ||
    item.endWeek != null ||
    (Array.isArray(item.selectedWeeks) && item.selectedWeeks.length)
  ) {
    out.startWeek = num(item.startWeek)
    out.endWeek = num(item.endWeek)
    out.weekType = num(item.weekType)
    out.selectedWeeks = Array.isArray(item.selectedWeeks) ? item.selectedWeeks.slice() : []
  }
  return out
}

function normalizeCourseList(list, dayKey) {
  const out = []
  if (!Array.isArray(list)) return out
  for (let i = 0; i < list.length; i++) {
    const c = normalizeCourse(list[i], i, dayKey)
    if (c) out.push(c)
  }
  out.sort(function (a, b) {
    return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  })
  return out
}

/**
 * 校验并归一化手机端 payload
 * 成功返回 { ok: true, payload }；失败返回 { ok: false, error }
 */
function normalizePayload(raw) {
  const parsed = parseMessage(raw)
  if (!parsed) {
    return { ok: false, error: 'empty payload' }
  }
  /** 诊断用：手机原始 payload 里出现了哪些已知字段（v2 改结构时靠它一眼看出来） */
  const KNOWN_FIELDS = [
    'protocol', 'version', 'action', 'data', 'courses', 'settings', 'times', 'holidays',
    'week', 'days', 'teachingWeek', 'current_week', 'class_start_time', 'total_weeks', 'schedule_name',
    'archive'
  ]
  const present = []
  const unknownNames = []
  let unknownMore = false
  const parsedKeys = Object.keys(parsed)
  for (let i = 0; i < parsedKeys.length; i++) {
    if (KNOWN_FIELDS.indexOf(parsedKeys[i]) >= 0) {
      present.push(parsedKeys[i])
    } else if (unknownNames.length < 4) {
      unknownNames.push('+' + parsedKeys[i])
    } else {
      unknownMore = true
    }
  }
  const rawFields = present.concat(unknownNames).join(',') + (unknownMore ? ',…' : '')
  // v2 可能把内容包一层 data 对象：{protocol, version, action, data:{settings, times, courses, ...}}
  const msg = isPlainObject(parsed.data) ? Object.assign({}, parsed, parsed.data) : parsed
  // 周归档只出现在本模块写的缓存里（手机 payload 不会有），原样带回给 applyPayload 恢复
  const archiveList = Array.isArray(msg.archive) ? msg.archive : null
  if (msg.protocol && msg.protocol !== PROTOCOL) {
    return { ok: false, error: 'protocol mismatch: ' + msg.protocol }
  }
  // 版本只用于日志/诊断：week 键的编号域由键本身决定（见 weekKeyToInternal），
  // 因此版本升级/回退都不会导致周一~周六整体错位。
  const version = msg.version != null ? Number(msg.version) : PROTOCOL_VERSION
  if (SUPPORTED_WIRE_VERSIONS.indexOf(version) < 0 && version !== CACHE_VERSION) {
    console.log('[sync] unexpected protocol version ' + version + '，按键值自行解析')
  }

  const action = msg.action || ACTION.REPLACE
  const holidayList = normalizeHolidays(msg.holidays)
  const week = {}
  for (let i = 0; i < 7; i++) week[i] = []

  if (action === ACTION.CLEAR) {
    return {
      ok: true,
      shape: '清空 字段[' + rawFields + ']',
      payload: {
        protocol: PROTOCOL,
        version: CACHE_VERSION,
        action: ACTION.CLEAR,
        sentAt: msg.sentAt || Date.now(),
        savedAt: msg.savedAt || 0,
        quote: msg.quote || '',
        archive: archiveList,
        holidays: holidayList,
        week: week
      }
    }
  }

  // 整表模式：手机一次推「整学期课程 + 学期设置 + 节次时间」，
  // 由手环自己算教学周并按周次规则过滤（见 schedule.setFullSchedule）。
  if (Array.isArray(msg.courses)) {
    const st = isPlainObject(msg.settings) ? msg.settings : {}
    return {
      ok: true,
      shape:
        '整表 字段[' +
        rawFields +
        '] 课' +
        msg.courses.length +
        ' 周' +
        (st.current_week != null ? st.current_week : st.teachingWeek != null ? st.teachingWeek : '?') +
        '/' +
        (st.total_weeks != null ? st.total_weeks : '?') +
        ' 假' +
        holidayList.length,
      payload: {
        protocol: PROTOCOL,
        version: CACHE_VERSION,
        action: action,
        sentAt: msg.sentAt || Date.now(),
        savedAt: msg.savedAt || 0,
        quote: msg.quote || '',
        archive: archiveList,
        scheduleName: String(msg.schedule_name || msg.scheduleName || ''),
        holidays: holidayList,
        mode: 'full',
        courses: msg.courses,
        settings: st,
        times: isPlainObject(msg.times) ? msg.times : {}
      }
    }
  }

  // 按日期直推（方案 2）：days = 「日期 → 当天已解析好的课程」，
  // 手环纯映射渲染，不做周次/节次/假期任何推算。
  const daysArr = Array.isArray(msg.days) ? msg.days : null
  const datesMode =
    isPlainObject(msg.days) || (daysArr && daysArr.length > 0 && daysArr[0] && daysArr[0].date != null)
  if (datesMode) {
    const dayCount = daysArr ? daysArr.length : Object.keys(msg.days).length
    return {
      ok: true,
      shape:
        '按日期 字段[' +
        rawFields +
        '] 天' +
        dayCount +
        ' 周' +
        (msg.week != null ? msg.week : msg.teachingWeek != null ? msg.teachingWeek : '?') +
        ' 假' +
        holidayList.length,
      payload: {
        protocol: PROTOCOL,
        version: CACHE_VERSION,
        action: action,
        sentAt: msg.sentAt || Date.now(),
        savedAt: msg.savedAt || 0,
        quote: msg.quote || '',
        archive: archiveList,
        scheduleName: String(msg.schedule_name || msg.scheduleName || ''),
        holidays: holidayList,
        mode: 'dates',
        days: msg.days,
        week: msg.week != null ? msg.week : msg.teachingWeek
      }
    }
  }

  let hasWeekFields = false
  if (isPlainObject(msg.week)) {
    const keys = Object.keys(msg.week)
    for (let i = 0; i < keys.length; i++) {
      const key = String(keys[i])
      const day = weekKeyToInternal(key)
      if (day < 0) {
        return { ok: false, error: 'invalid weekday key: ' + key }
      }
      week[day] = normalizeCourseList(msg.week[key], String(day))
      for (let j = 0; j < week[day].length && !hasWeekFields; j++) {
        const c = week[day][j]
        if (c.weekType != null || c.startWeek != null || c.endWeek != null || (c.selectedWeeks && c.selectedWeeks.length)) {
          hasWeekFields = true
        }
      }
    }
  } else if (Array.isArray(msg.days)) {
    for (let i = 0; i < msg.days.length; i++) {
      const dayItem = msg.days[i] || {}
      const day =
        dayItem.weekday != null
          ? weekKeyToInternal(dayItem.weekday)
          : internalWeekdayFromDate(dayItem.date)
      if (day < 0) {
        return { ok: false, error: 'invalid day entry index ' + i }
      }
      week[day] = normalizeCourseList(dayItem.courses, String(day))
      for (let j = 0; j < week[day].length && !hasWeekFields; j++) {
        const c = week[day][j]
        if (c.weekType != null || c.startWeek != null || c.endWeek != null || (c.selectedWeeks && c.selectedWeeks.length)) {
          hasWeekFields = true
        }
      }
    }
  } else if (action !== ACTION.ACK) {
    return { ok: false, error: 'missing week/days/courses' }
  }

  let keysText = '-'
  if (isPlainObject(msg.week)) keysText = Object.keys(msg.week).sort().join(',')
  else if (Array.isArray(msg.days)) keysText = 'days:' + msg.days.length
  let courseCount = 0
  for (let i = 0; i < 7; i++) courseCount += week[i].length

  // 快照模式也带上周次信息（teachingWeek / current_week / total_weeks / class_start_time）：
  // 桶里若还带每门课的周次规则，手环会自己按周过滤（v2 常见做法）。
  const settings = {
    class_start_time: msg.class_start_time != null ? msg.class_start_time : msg.classStartTime,
    teachingWeek: msg.teachingWeek != null ? msg.teachingWeek : msg.current_week,
    total_weeks: msg.total_weeks != null ? msg.total_weeks : msg.totalWeeks,
    morning_sections: msg.morning_sections,
    afternoon_sections: msg.afternoon_sections,
    evening_sections: msg.evening_sections
  }

  return {
    ok: true,
    shape:
      '周表 字段[' +
      rawFields +
      '] 键[' +
      keysText +
      '] 课' +
      courseCount +
      ' 假' +
      holidayList.length +
      (hasWeekFields ? ' 含周次' : ' 已按周过滤'),
    payload: {
      protocol: PROTOCOL,
      version: CACHE_VERSION,
      action: action,
      sentAt: msg.sentAt || Date.now(),
      savedAt: msg.savedAt || 0,
      quote: msg.quote || '',
      archive: archiveList,
      holidays: holidayList,
      mode: 'weeks',
      week: week,
      settings: settings,
      times: isPlainObject(msg.times) ? msg.times : {}
    }
  }
}

/**
 * 归一化假期/调休（兼容 HolidayManager.Entry）：
 * [{date|start, endDate|end, name, type, followWeek, followWeekday}]
 * type: 0=假期(隐藏课程) 1=调休(改上 followWeekday 的课，followWeekday 为手机域 1-7)
 */
function normalizeHolidays(list) {
  const out = []
  if (!Array.isArray(list)) return out
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!isPlainObject(item)) continue
    const start = String(item.start || item.date || '')
    const end = String(item.end || item.endDate || start)
    if (!start) continue
    const type = item.type == null ? 0 : parseInt(item.type, 10)
    const weekday = item.followWeekday == null ? -1 : parseInt(item.followWeekday, 10)
    const week = item.followWeek == null ? -1 : parseInt(item.followWeek, 10)
    out.push({
      start: start,
      end: end || start,
      name: String(item.name || ''),
      type: type === 1 ? 1 : 0,
      followWeek: isNaN(week) ? -1 : week,
      followWeekday: isNaN(weekday) ? -1 : weekday
    })
  }
  return out
}

/** 缓存里附带的历史周归档（空时为 undefined，JSON.stringify 自动忽略） */
function cacheArchive() {
  return schedule.archiveCount() ? schedule.getWeekArchive() : undefined
}

/** 写缓存：只保留有用字段并丢掉空白天，尽量小（storage 的 value 必须是字符串） */
function compactForCache(payload) {
  if (payload.mode === 'full') {
    return {
      protocol: PROTOCOL,
      version: CACHE_VERSION,
      action: payload.action || ACTION.REPLACE,
      savedAt: payload.savedAt || Date.now(),
      quote: payload.quote || '',
      scheduleName: payload.scheduleName || '',
      holidays: payload.holidays || [],
      mode: 'full',
      archive: cacheArchive(),
      courses: payload.courses || [],
      settings: payload.settings || {},
      times: payload.times || {}
    }
  }
  if (payload.mode === 'dates') {
    return {
      protocol: PROTOCOL,
      version: CACHE_VERSION,
      action: payload.action || ACTION.REPLACE,
      savedAt: payload.savedAt || Date.now(),
      quote: payload.quote || '',
      scheduleName: payload.scheduleName || '',
      holidays: payload.holidays || [],
      mode: 'dates',
      archive: cacheArchive(),
      days: payload.days || {},
      week: payload.week
    }
  }
  if (payload.mode === 'weeks') {
    const w = {}
    for (let i = 0; i < 7; i++) {
      const list = (payload.week && payload.week[i]) || []
      if (list.length) w[i] = list
    }
    return {
      protocol: PROTOCOL,
      version: CACHE_VERSION,
      action: payload.action || ACTION.REPLACE,
      savedAt: payload.savedAt || Date.now(),
      sentAt: payload.sentAt || 0,
      quote: payload.quote || '',
      holidays: payload.holidays || [],
      mode: 'weeks',
      archive: cacheArchive(),
      week: w,
      settings: payload.settings || {},
      times: payload.times || {}
    }
  }
  const week = {}
  for (let i = 0; i < 7; i++) {
    const list = (payload.week && payload.week[i]) || []
    if (list.length) week[i] = list
  }
  return {
    protocol: PROTOCOL,
    version: CACHE_VERSION,
    action: payload.action || ACTION.REPLACE,
    savedAt: payload.savedAt || Date.now(),
    quote: payload.quote || '',
    archive: cacheArchive(),
    holidays: payload.holidays || [],
    week: week
  }
}

/**
 * 存缓存时优先存「按日期直推」的数据：
 * 整周快照只代表手机推送那一刻的那一周，用它覆盖缓存会让冷启动后
 * 其它周（单双周、选周）又显示成那一周。
 * 按日期数据是合并语义（dateCourses 累积了各次推送的窗口），
 * 所以只要内存里有累积数据，无论本次 payload 是什么形态都用它写缓存。
 */
function toCachePayload(payload) {
  const dated = schedule.getDateCache()
  if (dated) {
    return {
      protocol: PROTOCOL,
      version: CACHE_VERSION,
      action: ACTION.REPLACE,
      savedAt: payload.savedAt || Date.now(),
      quote: payload.quote || '',
      scheduleName: payload.scheduleName || '',
      holidays: payload.holidays || [],
      mode: 'dates',
      archive: cacheArchive(),
      days: dated.days,
      week: dated.week
    }
  }
  return payload
}

function persist(payload, done) {
  const value = JSON.stringify(compactForCache(toCachePayload(payload)))
  // 文档：value 为空字符串等于删除该项，所以空内容不写
  if (!value || value === '{}') {
    if (done) done(null)
    return
  }
  try {
    storage.set({
      key: STORAGE_KEY,
      value: value,
      success: function () {
        cachedAt = payload.savedAt || Date.now()
        if (done) done(null)
      },
      fail: function (data, code) {
        lastError = 'storage.set fail ' + code
        if (done) done(lastError)
      }
    })
  } catch (e) {
    lastError = String(e)
    if (done) done(lastError)
  }
}

function applyPayload(payload) {
  cachedQuote = payload.quote || ''
  if (payload.action === ACTION.CLEAR) {
    schedule.replaceWeek({})
    schedule.clearWeekState()
    schedule.clearDateState()
    schedule.clearWeekArchive()
    schedule.setHolidays([])
    schedule.setQuote(cachedQuote)
    return
  }
  if (payload.mode === 'full') {
    // 整表模式：手环自己算周次，快照数据清掉，避免两种模式混用
    schedule.replaceWeek({})
    schedule.setFullSchedule({
      courses: payload.courses || [],
      settings: payload.settings || {},
      times: payload.times || {}
    })
  } else if (payload.mode === 'weeks') {
    if (payload.action === ACTION.UPSERT) {
      schedule.clearWeekState()
      schedule.mergeWeek(payload.week || {})
    } else {
      // 桶里带周次字段 → 手环自己按周过滤；否则就是手机已过滤的纯快照
      schedule.setWeekSnapshot({
        week: payload.week || {},
        settings: payload.settings || {},
        times: payload.times || {},
        sentAt: payload.sentAt
      })
    }
  } else if (payload.mode === 'dates') {
    schedule.setDateSchedule({ days: payload.days || {}, week: payload.week })
  } else {
    schedule.clearWeekState()
    schedule.clearDateState()
    if (payload.action === ACTION.UPSERT) {
      schedule.mergeWeek(payload.week || {})
    } else {
      schedule.replaceWeek(payload.week || {})
    }
  }
  schedule.setHolidays(payload.holidays || [])
  // 恢复缓存里带来的历史周归档（仅缓存路径会有该字段）
  if (payload.archive && payload.archive.length) {
    schedule.restoreWeekArchive(payload.archive)
  }
  schedule.setQuote(cachedQuote)
}

/**
 * 手机端消息统一入口（也可被调试工具直接调用）
 * @param {string|object} raw 手机推送
 * @returns {{ok:boolean, error?:string}}
 */
function handlePhoneMessage(raw) {
  const result = normalizePayload(raw)
  if (!result.ok) {
    lastError = result.error
    console.log('[sync] reject payload:', result.error)
    return result
  }
  appliedRev += 1
  const rev = appliedRev
  result.payload.savedAt = Date.now()
  lastSource = 'phone'
  lastShape = result.shape || ''
  lastAt = result.payload.savedAt
  applyPayload(result.payload)
  persist(result.payload, function () {
    if (rev === appliedRev) notify()
  })
  notify()
  sendAck(result.payload.sentAt)
  console.log('[sync] applied rev=' + rev + ' ' + lastShape)
  return { ok: true, shape: lastShape }
}

/** 收到整包并落地后回一个 ACK，手机端按 sentAt 匹配确认推送是否真正送达；
 *  失败仅记日志，不影响落地结果。 */
function sendAck(sentAt) {
  if (!connect || !sentAt) return
  connect.send({
    data: { protocol: PROTOCOL, version: PROTOCOL_VERSION, action: ACTION.ACK, sentAt: sentAt },
    success: function () {
      console.log('[sync] ack sent for sentAt=' + sentAt)
    },
    fail: function (data, code) {
      console.log('[sync] ack fail ' + code)
    }
  })
}

function handleMessageEvent(evt) {
  if (!evt) return
  // 文档：connect.onmessage 回调参数 data 为 String，实际可能是 { data }
  const raw = evt.data != null ? evt.data : evt
  handlePhoneMessage(raw)
}

function bindConnect() {
  if (!connect) return
  connect.onmessage = handleMessageEvent
  connect.onopen = function (data) {
    ready = true
    lastError = null
    console.log('[sync] interconnect open, reconnected=', data && data.isReconnected)
    notifyConnected()
    requestSync('reconnect')
    startPolling()
  }
  connect.onclose = function (data) {
    ready = false
    connectNotified = false
    lastError = (data && data.data) || 'closed'
    console.log('[sync] interconnect closed', lastError)
    // 手机断连后停止轮询，避免无效空转；重连时恢复
    stopPolling()
    // 断连即清掉挂起的重试链，避免重连后旧定时器误触发
    clearRetry()
  }
  connect.onerror = function (data) {
    ready = false
    connectNotified = false
    lastError = (data && (data.data || data.code)) || 'error'
    console.log('[sync] interconnect error', lastError)
    stopPolling()
    clearRetry()
  }
}

/** 清掉挂起的重试定时器并复位计数（断连/出错时调用） */
function clearRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  retryCount = 0
}

/**
 * 向手机端请求最新课表（**手动接口**，正常流程不调用）。
 * 手环是纯被动接收端：只有手机端用户点「推送到手环」（或手机端课表变更自动推送）
 * 才会有数据下来。保留此函数供将来加「手动刷新」入口使用；
 * 手机端 WearableScheduleSync 收到 action=request 会立刻整包推送，带节流 + 重试。
 */
function requestSync(reason, force) {
  if (!connect) return
  const now = Date.now()
  if (!force && now - lastRequestAt < REQUEST_MIN_GAP_MS) {
    console.log('[sync] request throttled (' + (reason || 'manual') + ')')
    return
  }
  lastRequestAt = now
  const body = {
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    action: ACTION.REQUEST,
    reason: reason || 'manual',
    sentAt: now
  }
  connect.send({
    data: body,
    success: function () {
      console.log('[sync] request sent (' + body.reason + ')')
      scheduleRetry()
    },
    fail: function (data, code) {
      lastError = 'request fail ' + code
      console.log('[sync] request fail', lastError)
      scheduleRetry()
    }
  })
}

/** 请求发出后若迟迟没有新数据，最多重试 MAX_RETRY 次 */
function scheduleRetry() {
  if (retryTimer) return
  const revAtRequest = appliedRev
  retryTimer = setTimeout(function () {
    retryTimer = null
    if (appliedRev !== revAtRequest) {
      retryCount = 0
      return
    }
    if (retryCount >= MAX_RETRY) {
      console.log('[sync] retry give up, 手机端没回应')
      retryCount = 0
      return
    }
    retryCount += 1
    requestSync('retry' + retryCount, true)
  }, RETRY_DELAY_MS)
}

/**
 * 主动要一次「按日期直推」数据（v2/v3 用户的兜底补数据；v4 整表模式下
 * hasFullSemester 为真，调用方会自动跳过）。带节流避免把通道刷爆。
 * @returns {boolean} 是否真的发出了请求
 */
function requestDatedData(reason) {
  if (!connect) return false
  const now = Date.now()
  if (now - lastNeedDatedAt < NEED_DATED_MIN_GAP_MS) return false
  lastNeedDatedAt = now
  needDatedCount += 1
  console.log('[sync] 缺少按日期数据，向手机请求 (' + (reason || 'need-dates') + ')')
  requestSync(reason || 'need-dates', true)
  return true
}

/**
 * 页面 onShow 调用：数据过期（或从未同步过）就主动向手机要一次。
 * 打开应用/从表盘回到应用时不再被动等推送；v2 用户缺按日期数据时也会催一次。
 */
function ensureFresh(reason) {
  const tag = reason || 'ensure-fresh'
  let askedForDates = false
  // 整表模式（含学期起始日）下手环能推算学期内任意一天，不必再向手机要按日期数据
  if (!schedule.hasDateFor(new Date()) && !schedule.hasFullSemester()) {
    askedForDates = requestDatedData(tag)
  }
  if (!lastAt || Date.now() - lastAt > STALE_MS) {
    retryCount = 0
    requestSync(tag, true)
    return true
  }
  // 数据还新，但通道没连上时也试一次（可能刚开机/刚重连）
  if (!ready && !schedule.hasFullSemester()) {
    requestSync(tag)
    return true
  }
  return askedForDates
}

/**
 * 启动同步通道：先恢复本地缓存，再监听手机消息
 * 有缓存时即使手机不在身边，页面也能显示上次同步的课表。
 */
function init() {
  // 缓存必须先读：冷启动时不依赖任何连接状态
  try {
    storage.get({
      key: STORAGE_KEY,
      success: function (data) {
        const raw = readStoredValue(data)
        if (!raw) return
        // 手机已经推过数据（更新），不要用旧缓存覆盖
        if (appliedRev > 0) return
        const result = normalizePayload(raw)
        if (!result.ok) {
          lastError = 'cache rejected: ' + result.error
          console.log('[sync] cache rejected:', result.error)
          return
        }
        cachedAt = result.payload.savedAt || 0
        lastSource = 'cache'
        lastShape = result.shape || ''
        lastAt = cachedAt
        applyPayload(result.payload)
        notify()
        console.log('[sync] cache restored, savedAt=' + cachedAt + ' ' + lastShape)
      },
      fail: function (data, code) {
        lastError = 'storage.get fail ' + code
      }
    })
  } catch (e) {
    lastError = String(e)
  }

  if (connect) return
  try {
    connect = interconnect.instance()
    bindConnect()
    connect.getReadyState({
      success: function (data) {
        ready = !!(data && data.status === 1)
        if (ready) {
          // 应用启动时通道已就绪：onopen 可能不会再触发，这里直接提示
          notifyConnected()
          requestSync('app-open')
          startPolling()
        }
      },
      fail: function (data, code) {
        lastError = 'getReadyState fail ' + code
      }
    })
  } catch (e) {
    lastError = String(e)
    console.log('[sync] init fail', lastError)
  }
}

/** 定时轮询：兜底自愈（手机端在身边时，错过的推送最迟一个周期被补上） */
function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(function () {
    // 手机不在身边时 request 会失败，重试机制会兜住；节流在 requestSync 内部
    requestSync('poll')
  }, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function teardown() {
  stopPolling()
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (connect) {
    try {
      connect.onmessage = null
      connect.onopen = null
      connect.onclose = null
      connect.onerror = null
    } catch (e) {
      // ignore
    }
    connect = null
  }
  ready = false
}

/**
 * 页面订阅数据变化，返回取消函数
 */
function onScheduleChange(fn) {
  if (typeof fn !== 'function') {
    return function () {}
  }
  listeners.push(fn)
  return function () {
    const idx = listeners.indexOf(fn)
    if (idx >= 0) listeners.splice(idx, 1)
  }
}

/**
 * 页面订阅 toast 消息（如「已连接手机」），自行在页面内定位展示，
 * 返回取消函数。系统 showToast 不可定位，只能作为无页面时的兜底。
 */
function onToast(fn) {
  if (typeof fn !== 'function') {
    return function () {}
  }
  toastListeners.push(fn)
  return function () {
    const idx = toastListeners.indexOf(fn)
    if (idx >= 0) toastListeners.splice(idx, 1)
  }
}

function getStatus() {
  return {
    ready: ready,
    lastError: lastError,
    peerPackage: PEER_PACKAGE,
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    cachedAt: cachedAt,
    hasCache: cachedAt > 0 || schedule.hasSyncedSchedule(),
    rev: appliedRev,
    lastSource: lastSource,
    lastShape: lastShape,
    lastAt: lastAt,
    /** 是否有「按日期直推」数据：false 表示手环只知道手机推来的那一周 */
    hasDates: schedule.hasDateFor(new Date()),
    /** 已累积的按日期天数 / 周归档数（诊断展示：覆盖面随使用增长） */
    datedDays: schedule.datedCount(),
    archiveWeeks: schedule.archiveCount(),
    /** 整表模式是否完整（有课表 + 学期起始日），可渲染学期内任意一天 */
    hasFull: schedule.hasFullSemester()
  }
}

export default {
  ACTION: ACTION,
  PROTOCOL: PROTOCOL,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  SUPPORTED_WIRE_VERSIONS: SUPPORTED_WIRE_VERSIONS,
  PEER_PACKAGE: PEER_PACKAGE,
  init: init,
  teardown: teardown,
  requestSync: requestSync,
  ensureFresh: ensureFresh,
  handlePhoneMessage: handlePhoneMessage,
  normalizePayload: normalizePayload,
  onScheduleChange: onScheduleChange,
  onToast: onToast,
  getStatus: getStatus
}
