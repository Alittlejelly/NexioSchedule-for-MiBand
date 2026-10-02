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
 * 一周课程：key 为 0-6（周日-周六，即 JS Date.getDay() 原生值）
 * 手机协议的 week 键可能是 0-6（手表域）或 1-7（手机域），
 * 换算只在 sync.js 的 weekKeyToInternal 边界完成，本模块只认 0-6。
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

/** 假期/调休条目（兼容 HolidayManager.Entry）；type 0=假期 1=调休 */
let holidays = []

function markSynced() {
  hasSynced = true
}

function hasSyncedSchedule() {
  return hasSynced
}

function setHolidays(list) {
  holidays = []
  if (!list || !list.length) return
  for (let i = 0; i < list.length; i++) {
    const h = list[i]
    if (!h || !h.start) continue
    const type = h.type === 1 ? 1 : 0
    holidays.push({
      start: h.start,
      end: h.end || h.start,
      name: h.name || '',
      type: type,
      followWeek: h.followWeek == null ? -1 : parseInt(h.followWeek, 10),
      followWeekday: h.followWeekday == null ? -1 : parseInt(h.followWeekday, 10)
    })
  }
}

function getHolidays() {
  return holidays.slice()
}

function dateKey(date) {
  const y = date.getFullYear()
  const m = date.getMonth() + 1
  const d = date.getDate()
  return y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d)
}

function findHolidayEntry(date, type) {
  if (!holidays.length) return null
  const key = dateKey(date)
  for (let i = 0; i < holidays.length; i++) {
    const h = holidays[i]
    if (type != null && h.type !== type) continue
    if (key >= h.start && key <= h.end) return h
  }
  return null
}

/** 手机 dayOfWeek(1=周一..7=周日；0 也按周日容错) → 手表 week key(0=周日..6=周六)，非法 -1 */
function phoneDayToWatchDay(phoneDay) {
  const d = parseInt(phoneDay, 10)
  if (isNaN(d)) return -1
  if (d === 0 || d === 7) return 0
  return d >= 1 && d <= 6 ? d : -1
}

/**
 * 调休条目的目标星期 → 手表内部 week key(0=周日..6=周六)。
 * 手机域标准写法是 1-7（7=周日）；0 也按周日容错（个别实现用 0 表示周日）。
 * 返回 -1 表示该条目没有可用映射（即 followWeekday 未配置）。
 */
function workSwapTargetDay(entry) {
  if (!entry) return -1
  return phoneDayToWatchDay(entry.followWeekday)
}

/**
 * 找当天命中的调休(补班)条目。
 * 同一天可能命中多条（跨年归档、custom 覆盖），优先返回「配置了有效 followWeekday」的那条，
 * 都没有配置时退回第一条 —— 手机端同样是按优先级挑一条来用。
 */
function findWorkSwap(date) {
  if (!holidays.length) return null
  const key = dateKey(date)
  let first = null
  for (let i = 0; i < holidays.length; i++) {
    const h = holidays[i]
    if (h.type !== 1) continue
    if (key < h.start || key > h.end) continue
    if (!first) first = h
    if (workSwapTargetDay(h) >= 0) return h
  }
  return first
}

/**
 * 解析某天显示用的星期键，规则与手机端 CourseReminderHelper.resolveDaySchedule 对齐：
 *   1. 当天是假期 → -1（不排课。手机端 HolidayCourseExclusion 默认也是隐藏，
 *      仅在「假期末日例外」开启时才保留命中课程，该配置不会下发给手表）
 *   2. 调休且 followWeekday(手机域 1-7) 有效 → 改上映射星期的课
 *   3. 其余（含「补班但未配置 followWeekday」）→ 当天日历星期
 * 注意顺序：假期判定必须在调休映射之后覆盖，手机端也是先算候选课再用假期清空。
 */
function resolveDisplayDayKey(date) {
  const mapped = workSwapTargetDay(findWorkSwap(date))
  if (findHolidayEntry(date, 0)) return -1
  if (mapped >= 0) return mapped
  return date.getDay()
}

function isHolidayDate(date) {
  if (isDateMode()) {
    const entry = dateCourses[dateKey(date)]
    return !!(entry && entry.isHoliday)
  }
  return findHolidayEntry(date, 0) != null
}

function holidayNameFor(date) {
  if (isDateMode()) {
    const entry = dateCourses[dateKey(date)]
    return entry && entry.holiday ? entry.holiday : ''
  }
  const h = findHolidayEntry(date, 0) || findHolidayEntry(date, 1)
  return h ? (h.name || '') : ''
}

/* ---------------------------------------------------------------------------
 * 整表模式：手机一次推「整学期课程 + 学期设置 + 节次时间」，手环自己算周次
 * ---------------------------------------------------------------------------
 * 字段与手机端 Course.kt / ShareScheduleData.kt 对齐：
 *   courses[]: { name, classroom, teacher, dayOfWeek(1=周一..7=周日),
 *                startSection, endSection, isCustomTime, customStartTime, customEndTime,
 *                startWeek, endWeek, weekType(0=全周 1=单周 2=双周), selectedWeeks[] }
 *   settings:  { class_start_time:'YYYY/MM/DD', current_week, total_weeks,
 *                morning_sections, afternoon_sections, evening_sections }
 *   times:     { morning:{'1':'08:00-08:40',...}, afternoon:{...}, evening:{...}, section_names:{...} }
 *
 * 与快照模式（手机按周过滤后只推一周）的区别：这里由手环按日期自己算教学周、
 * 自己按周次规则过滤，所以手环的「第几周」与手机永远一致，翻到任意一周都能正确显示。
 * 周次公式与手机端 CourseScheduleDateBounds.calendarWeekForDate 完全一致。
 * ------------------------------------------------------------------------- */

let fullCourses = []
let fullSettings = null
let fullSectionTimes = {}
/** 手机已按周过滤的纯快照：记录它属于第几周，用于界面标注 */
let snapshotWeek = 0

/* ---------------------------------------------------------------------------
 * 按日期直推模式（方案 2）：手机把「每一天有哪些课」解析好后整包发过来，
 * 手环不做任何推算 —— 不查周次、不判单双周、不换算节次、不判假期，
 * 只按日期查表渲染。
 *   days: { '2026-10-10': { courses:[...], week, holiday, isHoliday, isWorkSwap } }
 *   courses[]: { id, name, startTime, endTime, periods, section, location, teacher }
 * ------------------------------------------------------------------------- */
let dateCourses = {}
/** 手机给的当前教学周（按日期条目没带 week 时的兜底，仅用于界面标注） */
let dateWeekFallback = 0

function isDateMode() {
  return Object.keys(dateCourses).length > 0
}

/**
 * 写入按日期直推的数据
 * @param {object} data { days, week }
 */
function setDateSchedule(data) {
  dateCourses = {}
  dateWeekFallback = toInt(data && (data.week != null ? data.week : data.teachingWeek), 0)
  const days = data && data.days
  if (Array.isArray(days)) {
    for (let i = 0; i < days.length; i++) {
      const d = days[i]
      if (!d || !d.date) continue
      dateCourses[String(d.date)] = normalizeDateDay(d)
    }
  } else if (days && typeof days === 'object') {
    const keys = Object.keys(days)
    for (let i = 0; i < keys.length; i++) {
      const list = days[keys[i]]
      dateCourses[String(keys[i])] = {
        courses: Array.isArray(list) ? list : [],
        week: data && data.week ? toInt(data.week, 0) : 0,
        holiday: '',
        isHoliday: false,
        isWorkSwap: false
      }
    }
  }
  hasSynced = true
  fullCourses = []
  fullSettings = null
  fullSectionTimes = {}
  snapshotWeek = 0
}

function normalizeDateDay(d) {
  const list = []
  const raw = Array.isArray(d.courses) ? d.courses : Array.isArray(d.list) ? d.list : []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    const name = c && (c.name || c.courseName || c.title)
    if (!name) continue
    list.push({
      id: c.id != null ? String(c.id) : String(d.date || d.day || '') + '-' + i,
      name: name,
      startTime: c.startTime || c.start || '',
      endTime: c.endTime || c.end || '',
      periods: c.periods || c.sectionText || c.periodText || '',
      section: c.period || c.section || resolveSection('', c.startTime || ''),
      location: c.location || c.classroom || c.place || '',
      teacher: c.teacher || c.instructor || ''
    })
  }
  list.sort(function (a, b) {
    return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  })
  return {
    courses: list,
    week: toInt(d.week != null ? d.week : d.teachingWeek, 0),
    holiday: d.holiday || d.holidayName || '',
    isHoliday: !!d.isHoliday || !!d.holiday || !!d.holidayName,
    isWorkSwap: !!d.isWorkSwap
  }
}

function clearDateState() {
  dateCourses = {}
}

function isFullMode() {
  return !!(fullSettings || fullCourses.length)
}

function toInt(v, fallback) {
  const n = parseInt(v, 10)
  if (isNaN(n)) return fallback == null ? 0 : fallback
  return n
}

/** 'YYYY/MM/DD' 或 'YYYY-MM-DD' → 本地零点的 Date，非法返回 null */
function parseYmd(text) {
  const m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/.exec(String(text || ''))
  if (!m) return null
  const d = new Date(toInt(m[1]), toInt(m[2]) - 1, toInt(m[3]))
  return isNaN(d.getTime()) ? null : d
}

/**
 * 全局绝对节次号 → 'HH:mm-HH:mm'。
 * 上午 1..M，下午 M+1..M+A，晚上 M+A+1..M+A+E；times 里的编号是各时段「内部」编号。
 */
function buildSectionTimes(settings, times) {
  const src = times || {}
  const counts = [
    ['morning', settings.morning || Object.keys(src.morning || {}).length],
    ['afternoon', settings.afternoon || Object.keys(src.afternoon || {}).length],
    ['evening', settings.evening || Object.keys(src.evening || {}).length]
  ]
  const out = {}
  let base = 0
  for (let i = 0; i < counts.length; i++) {
    const name = counts[i][0]
    const count = counts[i][1] || 0
    const table = src[name] || {}
    for (let n = 1; n <= count; n++) {
      const v = table[String(n)] != null ? table[String(n)] : table[n]
      if (v != null && v !== '') out[base + n] = String(v)
    }
    base += count
  }
  return out
}

function normalizeFullSettings(raw) {
  const s = raw || {}
  return {
    semesterStart: parseYmd(s.class_start_time || s.classStartTime || s.start_date),
    currentWeek: toInt(
      s.current_week != null ? s.current_week : s.currentWeek != null ? s.currentWeek : s.teachingWeek,
      0
    ),
    totalWeeks: toInt(s.total_weeks != null ? s.total_weeks : s.totalWeeks, 0),
    morning: toInt(s.morning_sections != null ? s.morning_sections : s.morningSections, 0),
    afternoon: toInt(s.afternoon_sections != null ? s.afternoon_sections : s.afternoonSections, 0),
    evening: toInt(s.evening_sections != null ? s.evening_sections : s.eveningSections, 0)
  }
}

/**
 * 快照模式（week 桶）的周次设置：周次同样只认手机给的值。
 */
function normalizeWeekSettings(raw) {
  return normalizeFullSettings(raw)
}

/** 手机若直接给了时段（'morning'/'afternoon'/'evening' 或 0/1/2）就照用 */
function normalizePeriodField(v) {
  if (v == null) return ''
  const s = String(v).trim()
  if (SECTION_META[s]) return s
  if (s === '0') return 'morning'
  if (s === '1') return 'afternoon'
  if (s === '2') return 'evening'
  return ''
}

function normalizeFullCourse(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const name = raw.name || ''
  if (!name) return null
  const day = raw.day != null ? toInt(raw.day, -1) : phoneDayToWatchDay(raw.dayOfWeek)
  if (day < 0) return null
  const selected = []
  if (Array.isArray(raw.selectedWeeks)) {
    for (let i = 0; i < raw.selectedWeeks.length; i++) {
      const w = toInt(raw.selectedWeeks[i], -1)
      if (w > 0) selected.push(w)
    }
  }
  return {
    id: raw.id != null ? String(raw.id) : 'f' + day + '-' + index,
    name: name,
    location: raw.location || raw.classroom || '',
    teacher: raw.teacher || '',
    day: day,
    startSection: toInt(raw.startSection, 0),
    endSection: toInt(raw.endSection, 0),
    isCustomTime: !!raw.isCustomTime,
    customStartTime: raw.customStartTime || '',
    customEndTime: raw.customEndTime || '',
    startWeek: toInt(raw.startWeek, 0),
    endWeek: toInt(raw.endWeek, 0),
    weekType: toInt(raw.weekType, 0),
    selectedWeeks: selected,
    periodsOverride: raw.periods || raw.sectionText || '',
    periodField: normalizePeriodField(raw.period != null ? raw.period : raw.section)
  }
}

/**
 * 写入整表（手机推送与缓存恢复共用）。传 null / 无 courses 时清空整表模式。
 * @param {object|null} data { courses, settings, times }
 */
function setFullSchedule(data) {
  clearDateState()
  if (!data || !Array.isArray(data.courses)) {
    fullCourses = []
    fullSettings = null
    fullSectionTimes = {}
    return
  }
  const settings = normalizeFullSettings(data.settings)
  fullSettings = settings
  fullSectionTimes = buildSectionTimes(settings, data.times)
  const list = []
  for (let i = 0; i < data.courses.length; i++) {
    const c = normalizeFullCourse(data.courses[i], i)
    if (c) list.push(c)
  }
  fullCourses = list
  hasSynced = true
}

/**
 * 快照模式（week 桶）写入。两种情形：
 *  1. 桶里的课自带周次字段（startWeek/endWeek/weekType/selectedWeeks）→ 视为「没按周过滤」，
 *     升级成整表模式，由手环自己算周次并按周过滤（v2 常见做法）；
 *  2. 桶里的课没有周次字段 → 手机已按周过滤，照旧按桶显示，只把「第几周」记下来标注。
 * @param {object} data { week, settings, times, sentAt }
 */
function setWeekSnapshot(data) {
  clearDateState()
  const buckets = (data && data.week) || {}
  const settings = normalizeWeekSettings(data && data.settings, data && data.sentAt)
  let hasWeeks = false
  const dayKeys = Object.keys(buckets)
  for (let k = 0; k < dayKeys.length && !hasWeeks; k++) {
    const list = buckets[dayKeys[k]] || []
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      if (
        c &&
        (c.weekType != null ||
          c.startWeek != null ||
          c.endWeek != null ||
          (c.selectedWeeks && c.selectedWeeks.length))
      ) {
        hasWeeks = true
        break
      }
    }
  }

  if (!hasWeeks) {
    writeWeek(buckets)
    snapshotWeek = settings.currentWeek > 0 ? settings.currentWeek : 0
    fullCourses = []
    fullSettings = null
    fullSectionTimes = {}
    hasSynced = true
    return
  }

  const list = []
  for (let k = 0; k < dayKeys.length; k++) {
    const day = parseInt(dayKeys[k], 10)
    if (isNaN(day) || day < 0 || day > 6) continue
    const arr = buckets[dayKeys[k]] || []
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i]
      const norm = normalizeFullCourse(
        {
          id: c.id,
          name: c.name,
          location: c.location,
          teacher: c.teacher,
          day: day,
          startSection: c.startSection,
          endSection: c.endSection,
          isCustomTime: c.isCustomTime || (!c.startSection && !!c.startTime),
          customStartTime: c.customStartTime || c.startTime,
          customEndTime: c.customEndTime || c.endTime,
          startWeek: c.startWeek,
          endWeek: c.endWeek,
          weekType: c.weekType,
          selectedWeeks: c.selectedWeeks
        },
        list.length
      )
      if (norm) {
        if (c.periods) norm.periodsOverride = c.periods
        list.push(norm)
      }
    }
  }
  fullSettings = settings
  fullSectionTimes = buildSectionTimes(settings, (data && data.times) || {})
  fullCourses = list
  snapshotWeek = 0
  hasSynced = true
}

/** 清掉整表/快照的周次状态（切回纯桶模式时用） */
function clearWeekState() {
  fullCourses = []
  fullSettings = null
  fullSectionTimes = {}
  snapshotWeek = 0
}

/**
 * 当前生效的教学周：**直接采用手机 payload 里给的值**（current_week / teachingWeek）。
 * 手环不再根据日期自己推算周次 —— 手机才是唯一权威，避免两边差一周。
 * 返回 0 表示手机没给周次（此时不做任何周次过滤，推什么显示什么）。
 */
function activeWeek() {
  if (fullSettings && fullSettings.currentWeek > 0) return fullSettings.currentWeek
  return snapshotWeek > 0 ? snapshotWeek : 0
}

function weekTextFor(date) {
  if (isDateMode()) {
    const entry = dateCourses[dateKey(date)]
    const w = entry && entry.week > 0 ? entry.week : dateWeekFallback
    return w > 0 ? '第' + w + '周' : ''
  }
  const week = activeWeek()
  return week > 0 ? '第' + week + '周' : ''
}

/** 与手机端 Course.isActiveInWeek 一致（selectedWeeks 优先；周次范围缺失时视为全周有效） */
function isCourseActiveInWeek(c, week) {
  if (c.selectedWeeks && c.selectedWeeks.length) {
    for (let i = 0; i < c.selectedWeeks.length; i++) {
      if (c.selectedWeeks[i] === week) return true
    }
    return false
  }
  // v2 可能不带 startWeek/endWeek（都为 0）：此时不能把整门课判没
  if (c.startWeek > 0 || c.endWeek > 0) {
    if (week < c.startWeek || week > c.endWeek) return false
  }
  if (c.weekType === 1) return week % 2 === 1
  if (c.weekType === 2) return week % 2 === 0
  return true
}

/**
 * 某天查课用的教学周。
 * 与手机端一致：调休条目带 followWeek(>0) 时，补的是「那一周」的课，
 * 而不是补班日所在周的课（CourseReminderHelper: displayWeek = followWeek ?: liveWeek）。
 */
function lookupWeekFor(date) {
  const swap = findWorkSwap(date)
  if (swap && swap.followWeek > 0) return swap.followWeek
  return activeWeek()
}

function hmToMinutes(hm) {
  const parts = String(hm || '').split(':')
  if (parts.length !== 2) return -1
  const h = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  if (isNaN(h) || isNaN(m)) return -1
  return h * 60 + m
}

function sectionStartMinutes(section) {
  const range = fullSectionTimes[section]
  if (!range) return -1
  return hmToMinutes(String(range).split('-')[0])
}

/** 与手机端 Course.periodIndex 一致：优先用手机给的 period/section 字段，其次按墙钟，最后按节次号 */
function fullCourseSection(c) {
  if (c.periodField && SECTION_META[c.periodField]) return c.periodField
  const M = fullSettings ? fullSettings.morning || 0 : 0
  const A = fullSettings ? fullSettings.afternoon || 0 : 0
  const t = fullCourseTimes(c)
  const startMin = hmToMinutes(t.startTime)
  if (startMin >= 0) {
    let aStart = sectionStartMinutes(M + 1)
    if (aStart < 0) aStart = 12 * 60
    let eStart = sectionStartMinutes(M + A + 1)
    if (eStart < 0) eStart = 18 * 60 + 30
    if (startMin < aStart) return 'morning'
    if (startMin < eStart) return 'afternoon'
    return 'evening'
  }
  if (c.startSection > 0) {
    if (c.startSection <= M) return 'morning'
    if (c.startSection <= M + A) return 'afternoon'
    return 'evening'
  }
  return resolveSection('', '')
}

/** 'HH:mm' 形式校验 */
function isHm(v) {
  return /^\d{1,2}:\d{2}$/.test(String(v || ''))
}

/**
 * 与手机端 Course.getEffectiveStartTime / getEffectiveEndTime 一致。
 * payload 里已经带了手机解析好的时间就直接用（v2 的节次编号域不确定，
 * 用现成时间更可靠）；否则按全局节次号查 times 表。
 */
function fullCourseTimes(c) {
  if (isHm(c.customStartTime) && isHm(c.customEndTime)) {
    return { startTime: c.customStartTime, endTime: c.customEndTime }
  }
  const s = fullSectionTimes[c.startSection]
  const e = fullSectionTimes[c.endSection]
  return {
    startTime: s ? String(s).split('-')[0].trim() : '',
    endTime: e ? String(e).split('-').pop().trim() : ''
  }
}

function fullSectionText(c) {
  if (c.periodsOverride) return c.periodsOverride
  if (c.isCustomTime) return ''
  if (c.startSection <= 0 && c.endSection <= 0) return ''
  return c.startSection === c.endSection
    ? '第' + c.startSection + '节'
    : '第' + c.startSection + '-' + c.endSection + '节'
}

/** 整表模式下某天的展示课程（周次按手机给的值过滤；手机没给周次就不过滤） */
function fullCoursesForDay(day, week) {
  const out = []
  for (let i = 0; i < fullCourses.length; i++) {
    const c = fullCourses[i]
    if (c.day !== day) continue
    if (week > 0 && !isCourseActiveInWeek(c, week)) continue
    const t = fullCourseTimes(c)
    out.push({
      id: c.id,
      name: c.name,
      location: c.location,
      teacher: c.teacher,
      startTime: t.startTime,
      endTime: t.endTime,
      periods: fullSectionText(c),
      section: fullCourseSection(c),
      week: week
    })
  }
  out.sort(function (a, b) {
    const x = a.startTime || ''
    const y = b.startTime || ''
    return x < y ? -1 : x > y ? 1 : 0
  })
  return out
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
  // 按日期直推：手机给什么就显示什么（不查周次、不判单双周、不判假期）
  if (isDateMode()) {
    const entry = dateCourses[dateKey(date)]
    return entry ? entry.courses.slice() : []
  }
  const day = resolveDisplayDayKey(date)
  if (day < 0) return []
  // 整表模式：周次按手机给的值过滤
  if (isFullMode()) return fullCoursesForDay(day, lookupWeekFor(date))
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
    if (isHolidayDate(date) || resolveDisplayDayKey(date) < 0) {
      emptyState = 'holiday'
    } else {
      emptyState = hasSynced ? 'no-class' : 'need-phone'
    }
  }

  return {
    isToday: isToday,
    weekday: getWeekdayName(date),
    dateText: util.formatDate(date),
    week: activeWeek(),
    weekText: weekTextFor(date),
    quote: quoteText,
    hasCourses: hasCourses,
    hasNext: !!nextView,
    nextCourse: nextView,
    groups: sectionViews,
    hasSynced: hasSynced,
    isHoliday: isHolidayDate(date),
    holidayName: holidayNameFor(date),
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
  setFullSchedule,
  setWeekSnapshot,
  setDateSchedule,
  clearDateState,
  isDateMode,
  clearWeekState,
  isFullMode,
  activeWeek,
  weekTextFor,
  setQuote,
  getQuote,
  setHolidays,
  getHolidays,
  isHolidayDate,
  holidayNameFor,
  findWorkSwap,
  resolveDisplayDayKey,
  resolveSection,
  getWeekdayName,
  buildHomeViewModel,
  buildMeta,
  markSynced,
  hasSyncedSchedule
}
