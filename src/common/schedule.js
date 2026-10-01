/**
 * 课程表数据源
 * 内存中的周课表 + 与手机端同步后的视图模型组装
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const SECTION_META = {
  morning: { key: 'morning', label: '上午课程' },
  afternoon: { key: 'afternoon', label: '下午课程' },
  evening: { key: 'evening', label: '晚上课程' }
}

const SECTION_ORDER = ['morning', 'afternoon', 'evening']

/**
 * 一周课程：key 为 0-6（周日-周六）
 * 每节课：{ id, name, location, teacher, startTime, endTime, periods, section }
 * 默认空表，数据只来自手机同步，避免示例课造成误解
 */
const weeklySchedule = {
  0: [],
  1: [],
  2: [],
  3: [],
  4: [],
  5: [],
  6: []
}

/** 是否已收到过手机端课表（用于区分「未连接」和「今日无课」） */
let hasSynced = false

function markSynced() {
  hasSynced = true
}

function hasSyncedSchedule() {
  return hasSynced
}

let quoteText = ''

function setQuote(text) {
  quoteText = text || ''
}

function getQuote() {
  return quoteText
}

/**
 * 按开始时间推断上午/下午/晚上
 */
function resolveSection(section, startTime) {
  if (section && SECTION_META[section]) return section
  const hh = parseInt((startTime || '').split(':')[0], 10)
  if (isNaN(hh)) return 'afternoon'
  if (hh < 12) return 'morning'
  if (hh < 18) return 'afternoon'
  return 'evening'
}

function cloneCourse(course, index, dayKey) {
  return {
    id: course.id || dayKey + '-' + index,
    name: course.name || '',
    location: course.location || '',
    teacher: course.teacher || '',
    startTime: course.startTime || '',
    endTime: course.endTime || '',
    periods: course.periods || '',
    section: resolveSection(course.section, course.startTime)
  }
}

function sortCourses(list) {
  list.sort(function (a, b) {
    return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  })
  return list
}

function emptyWeek() {
  const week = {}
  for (let i = 0; i < 7; i++) week[i] = []
  return week
}

function writeWeek(week) {
  const keys = Object.keys(week || {})
  for (let i = 0; i < 7; i++) {
    weeklySchedule[i] = []
  }
  for (let k = 0; k < keys.length; k++) {
    const day = parseInt(keys[k], 10)
    if (isNaN(day) || day < 0 || day > 6) continue
    const list = week[keys[k]] || []
    const next = []
    for (let i = 0; i < list.length; i++) {
      next.push(cloneCourse(list[i], i, String(day)))
    }
    weeklySchedule[day] = sortCourses(next)
  }
}

/**
 * 整周覆盖（手机端全量同步）
 */
function replaceWeek(week) {
  writeWeek(week)
  hasSynced = true
}

/**
 * 按天合并（只更新有数据的星期）
 */
function mergeWeek(week) {
  hasSynced = true
  const keys = Object.keys(week || {})
  for (let k = 0; k < keys.length; k++) {
    const day = parseInt(keys[k], 10)
    if (isNaN(day) || day < 0 || day > 6) continue
    const list = week[keys[k]] || []
    const next = []
    for (let i = 0; i < list.length; i++) {
      next.push(cloneCourse(list[i], i, String(day)))
    }
    weeklySchedule[day] = sortCourses(next)
  }
}

/**
 * 兼容旧入口：用外部课程列表覆盖本地缓存
 */
function setSchedule(nextWeeklySchedule) {
  mergeWeek(nextWeeklySchedule || {})
}

function getTodayCourses(date) {
  const day = date.getDay()
  return (weeklySchedule[day] || []).slice()
}

/**
 * 指定日期的课程（周课表按星期取）
 */
function getCoursesForDate(date) {
  return getTodayCourses(date)
}

/**
 * 将课程按上午/下午/晚上分组，保持时间顺序
 */
function groupBySection(courses) {
  const buckets = {
    morning: [],
    afternoon: [],
    evening: []
  }
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i]
    const key = buckets[c.section] ? c.section : 'afternoon'
    buckets[key].push(c)
  }
  const groups = []
  for (let i = 0; i < SECTION_ORDER.length; i++) {
    const key = SECTION_ORDER[i]
    if (buckets[key].length > 0) {
      groups.push({
        key: key,
        label: SECTION_META[key].label,
        courses: buckets[key]
      })
    }
  }
  return groups
}

/**
 * 找出正在上的课（开始含、结束不含；若当前无课则返回 null）
 */
function getCurrentCourse(courses, now, dayDate) {
  const base = dayDate || now
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i]
    const start = parseCourseTime(c.startTime, base)
    const end = parseCourseTime(c.endTime, base)
    if (now.getTime() >= start.getTime() && now.getTime() < end.getTime()) {
      return c
    }
  }
  return null
}

/**
 * 找出下节课（今天尚未开始的第一节；若今天已上完则返回 null）
 */
function getNextCourse(courses, now, dayDate) {
  const base = dayDate || now
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i]
    const start = parseCourseTime(c.startTime, base)
    if (start.getTime() > now.getTime()) {
      return c
    }
  }
  return null
}

function parseCourseTime(timeStr, baseDate) {
  const parts = (timeStr || '').split(':')
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate())
  d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0)
  return d
}

function getWeekdayName(date) {
  return WEEKDAYS[date.getDay()]
}

/**
 * 组装首页展示模型（与手机端今日页字段对齐）
 * viewDate：要查看的日期；realNow：真实当前时刻（用于状态/倒计时）
 * 上课中：顶部卡片显示正在上的课，倒计时为距下课；否则显示下节课与距上课。
 */
function buildHomeViewModel(viewDate, util, realNow) {
  const date = viewDate || new Date()
  const now = realNow || date
  const isToday = util.isSameDay(date, now)
  const courses = getCoursesForDate(date)
  const groups = groupBySection(courses)
  const current = isToday ? getCurrentCourse(courses, now, date) : null
  const next = isToday ? getNextCourse(courses, now, date) : null

  const sectionViews = []
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const items = []
    for (let j = 0; j < g.courses.length; j++) {
      const c = g.courses[j]
      const statusInfo = util.getCourseStatus(c, now, date)
      items.push({
        id: c.id,
        name: c.name,
        timeText: c.startTime + ' - ' + c.endTime,
        meta: buildMeta(c),
        status: statusInfo.status,
        countdown: statusInfo.countdown.text,
        section: c.section
      })
    }
    sectionViews.push({
      key: g.key,
      label: g.label,
      courses: items
    })
  }

  // 上课中优先展示当前课，倒计时改距下课；否则维持「下节课 + 距上课」
  const focus = current || next
  let nextView = null
  if (focus) {
    const isCurrent = !!current
    const base = date
    const target = isCurrent
      ? parseCourseTime(focus.endTime, base)
      : parseCourseTime(focus.startTime, base)
    const cd = isCurrent ? util.formatRemain(target, now) : util.formatCountdown(target, now)
    nextView = {
      id: focus.id,
      name: focus.name,
      label: isCurrent ? '正在上课' : '下节课',
      timeText: focus.startTime + ' - ' + focus.endTime,
      meta: buildMeta(focus),
      countdown: cd.text
    }
  }

  const hasCourses = courses.length > 0
  let emptyState = 'none'
  if (!hasCourses) {
    emptyState = hasSynced ? 'no-class' : 'need-phone'
  }

  return {
    isToday: isToday,
    weekday: getWeekdayName(date),
    dateText: util.formatDate(date),
    quote: quoteText,
    hasCourses: hasCourses,
    hasNext: !!nextView,
    nextCourse: nextView,
    groups: sectionViews,
    hasSynced: hasSynced,
    emptyState: emptyState
  }
}

/**
 * 卡片副文案：节次 | 地点 | 教师（与手机端一致，空字段自动省略）
 */
function buildMeta(course) {
  const parts = []
  if (course.periods) parts.push(course.periods)
  if (course.location) parts.push(course.location)
  if (course.teacher) parts.push(course.teacher)
  return parts.join(' | ')
}

export default {
  weeklySchedule,
  WEEKDAYS,
  SECTION_META,
  getTodayCourses,
  getCoursesForDate,
  groupBySection,
  getCurrentCourse,
  getNextCourse,
  setSchedule,
  replaceWeek,
  mergeWeek,
  setQuote,
  getQuote,
  resolveSection,
  getWeekdayName,
  buildHomeViewModel,
  buildMeta,
  markSynced,
  hasSyncedSchedule
}
