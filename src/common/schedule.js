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

/**
 * 假期判定：按日期直推的「这一天」条目最权威（手机逐日解析过），
 * 该日没有条目时（超出手机推送窗口）再回退到手机下发的 holidays 列表。
 */
function isHolidayDate(date) {
  const entry = dateCourses[dateKey(date)]
  if (entry) return !!entry.isHoliday
  return findHolidayEntry(date, 0) != null
}

function holidayNameFor(date) {
  const entry = dateCourses[dateKey(date)]
  if (entry) return entry.holiday ? entry.holiday : ''
  const h = findHolidayEntry(date, 0) || findHolidayEntry(date, 1)
  return h ? (h.name || '') : ''
}

/** 某一天是否有「按日期直推」的数据（手环据此判断能否显示任意日期的课表） */
function hasDateFor(date) {
  return Object.prototype.hasOwnProperty.call(dateCourses, dateKey(date || new Date()))
}

/**
 * 按日期直推数据的缓存副本（**手机 payload 的 days 数组形态**，不是内部条目形态：
 * 存进 storage 后要走和手机推送同一条 normalizePayload → setDateSchedule 还原）。
 * sync.js 存缓存时优先存它：手机推的「整周快照」只代表推送那一刻的那一周，
 * 若用它覆盖缓存，冷启动后其它周（单双周）又会显示错。
 */
function getDateCache() {
  const keys = Object.keys(dateCourses)
  if (!keys.length) return null
  const days = []
  for (let i = 0; i < keys.length; i++) {
    const entry = dateCourses[keys[i]]
    days.push({
      date: keys[i],
      week: entry.week,
      courses: entry.courses || [],
      holiday: entry.holiday || '',
      isHoliday: !!entry.isHoliday,
      isWorkSwap: !!entry.isWorkSwap
    })
  }
  days.sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  })
  return { days: days, week: dateWeekFallback }
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
/** 整表周次校准偏移（调休合并周等导致日历周与手机教学周的差），见 calibrateWeekOffset */
let weekOffset = 0
/** 手机已按周过滤的纯快照：记录它属于第几周，用于界面标注 */
let snapshotWeek = 0

/* ---------------------------------------------------------------------------
 * 按日期直推模式（方案 2）：手机把「每一天有哪些课」解析好后整包发过来，
 * 手环不做任何推算 —— 不查周次、不判单双周、不换算节次、不判假期，
 * 只按日期查表渲染。
 *   days: { '2026-10-10': { courses:[...], week, holiday, isHoliday, isWorkSwap } }
 *   courses[]: { id, name, startTime, endTime, periods, section, location, teacher }
 * 手机每次只推「今天 ±14 天」的窗口（其工程 buildDaysJson 的默认窗口），
 * 所以这里**合并**而不是替换：窗口随时间滑动，累积的日期覆盖越来越多。
 * ------------------------------------------------------------------------- */
let dateCourses = {}
/** 手机给的当前教学周（按日期条目没带 week 时的兜底，仅用于界面标注） */
let dateWeekFallback = 0
/** 按日期数据最多保留的天数（防止 storage 与内存无界增长） */
const DATE_KEEP_MAX = 400

/* ---------------------------------------------------------------------------
 * 周快照归档：手机 v1/v2 的整周分桶包只含「推送那一刻的当前教学周」，
 * 过去每收到一周就把上一周顶掉 —— 手环永远只有一周课表（「天数太少」的根因）。
 * 现在把每周快照按「该周的周一」归档，翻到历史周时直接取归档数据。
 * ------------------------------------------------------------------------- */
let weekArchive = {}
/** 归档最多保留的周数（约一学期） */
const WEEK_ARCHIVE_MAX = 30

function mondayKey(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return dateKey(d)
}

/** 归档一周快照（同周重推覆盖；超过上限丢最旧的） */
function archiveWeek(key, buckets, stampAt) {
  if (!key || !buckets || typeof buckets !== 'object') return
  const week = {}
  let count = 0
  for (let i = 0; i < 7; i++) {
    week[i] = (Array.isArray(buckets[i]) ? buckets[i] : []).map(function (c, idx) {
      return cloneCourse(c, idx, String(i))
    })
    count += week[i].length
  }
  weekArchive[key] = { savedAt: stampAt || Date.now(), courses: count, week: week }
  const keys = Object.keys(weekArchive)
  if (keys.length > WEEK_ARCHIVE_MAX) {
    keys.sort(function (a, b) {
      return (weekArchive[a].savedAt || 0) - (weekArchive[b].savedAt || 0)
    })
    while (keys.length > WEEK_ARCHIVE_MAX) {
      delete weekArchive[keys.shift()]
    }
  }
}

function clearWeekArchive() {
  weekArchive = {}
}

function archiveCount() {
  return Object.keys(weekArchive).length
}

/** 导出归档（缓存持久化用） */
function getWeekArchive() {
  const keys = Object.keys(weekArchive).sort()
  const out = []
  for (let i = 0; i < keys.length; i++) {
    const entry = weekArchive[keys[i]]
    out.push({ monday: keys[i], savedAt: entry.savedAt || 0, week: entry.week })
  }
  return out
}

/** 恢复归档（缓存读取用；与手机推送同一条 normalize 链路已在上游完成） */
function restoreWeekArchive(list) {
  weekArchive = {}
  if (!Array.isArray(list)) return
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.monday || ''))) continue
    archiveWeek(String(item.monday), item.week, item.savedAt)
  }
}

/* ---------------------------------------------------------------------------
 * 单双周规律推断（v2 兼容）：线上手机端只推「当前教学周」的分桶快照，
 * 推送发生在单周的用户，快照里没有双周课 —— 该显示双周课的日子
 * 被套上了单周快照的内容（「双周显示单周课」）；推送发生在双周的用户则正常。
 * 归档/按日期数据凑齐 ≥2 个不同周的观测后，按课程出现/缺席的周序推断规律：
 *   - 所有观测周都出现 → 视为每周都有；
 *   - 部分周出现、部分周缺席 → 出现周奇偶一致时按单/双周推断，
 *     否则只认观测过的周；
 *   - 只观测到 1 周 → 无法推断，维持快照行为。
 * 推断只填充归档/按日期都没覆盖的日期，真数据到达后自动被覆盖（自愈）；
 * 并限制在观测范围 ±2 周内，把「课程提前结束」造成的误显示压到最小。
 * ------------------------------------------------------------------------- */
const INFER_HORIZON_WEEKS = 2

/** 目标日期所在周的周一（零点） */
function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

/** 汇总观测：{ 周一毫秒: { days: {0..6: [course]} } }，来源 = 周归档 + 按日期条目 */
function buildObservations() {
  const weeks = {}
  const keys = Object.keys(weekArchive)
  for (let i = 0; i < keys.length; i++) {
    const monday = parseYmd(keys[i])
    if (!monday) continue
    const entry = weekArchive[keys[i]]
    const days = {}
    for (let d = 0; d < 7; d++) days[d] = entry.week[d] || []
    weeks[monday.getTime()] = { days: days }
  }
  const dates = Object.keys(dateCourses)
  for (let i = 0; i < dates.length; i++) {
    const d = parseYmd(dates[i])
    if (!d) continue
    const ms = mondayOf(d).getTime()
    if (!weeks[ms]) weeks[ms] = { days: {} }
    const dayIdx = d.getDay()
    const list = dateCourses[dates[i]].courses || []
    const bucket = weeks[ms].days[dayIdx]
    weeks[ms].days[dayIdx] = bucket && bucket.length ? bucket.concat(list) : list.slice()
  }
  return weeks
}

/**
 * 推断某天（未归档、无按日期条目）的课程列表。
 * @returns {Array|null} null = 无法推断（调用方走原有回退）
 */
function inferCoursesForDate(date, dayIdx) {
  // 整表模式有自己的周次推算，不叠加这套启发式
  if (isFullMode()) return null
  const weeks = buildObservations()
  const msKeys = Object.keys(weeks)
    .map(Number)
    .sort(function (a, b) {
      return a - b
    })
  if (msKeys.length < 2) return null
  const ordOf = function (ms) {
    return Math.round((ms - msKeys[0]) / 604800000)
  }
  const ords = []
  for (let i = 0; i < msKeys.length; i++) ords.push(ordOf(msKeys[i]))
  const t = ordOf(mondayOf(date).getTime())
  const min = ords[0]
  const max = ords[ords.length - 1]
  if (t > max + INFER_HORIZON_WEEKS || t < min - INFER_HORIZON_WEEKS) return null

  // 按课程签名（id 优先）聚合「目标星期」在各观测周的出现/缺席
  const sigs = {}
  for (let i = 0; i < msKeys.length; i++) {
    const list = weeks[msKeys[i]].days[dayIdx] || []
    for (let j = 0; j < list.length; j++) {
      const c = list[j]
      const key =
        c.id != null && c.id !== ''
          ? 'i:' + c.id
          : 'n:' + c.name + '|' + (c.startTime || '') + '|' + (c.location || '')
      if (!sigs[key]) sigs[key] = { course: c, seen: {}, absent: {} }
      sigs[key].seen[ords[i]] = true
    }
  }
  for (const key in sigs) {
    for (let i = 0; i < ords.length; i++) {
      if (!sigs[key].seen[ords[i]]) sigs[key].absent[ords[i]] = true
    }
  }

  const out = []
  for (const key in sigs) {
    const info = sigs[key]
    const seenOrds = Object.keys(info.seen)
      .map(Number)
      .sort(function (a, b) {
        return a - b
      })
    if (!seenOrds.length) continue
    let include = false
    if (info.seen[t]) {
      include = true
    } else {
      let hasAbsent = false
      for (const a in info.absent) {
        hasAbsent = true
        break
      }
      if (!hasAbsent) {
        // 所有观测周都在 → 每周都有
        include = true
      } else {
        // 有缺席 → 出现周奇偶（相对观测网格）一致时按单/双周推断
        let allEven = true
        let allOdd = true
        for (let i = 0; i < seenOrds.length; i++) {
          if (seenOrds[i] % 2 !== 0) allEven = false
          if (seenOrds[i] % 2 !== 1) allOdd = false
        }
        if (allEven) include = t % 2 === 0
        else if (allOdd) include = t % 2 === 1
      }
    }
    if (include) out.push(cloneCourse(info.course, out.length, String(dayIdx)))
  }
  return out
}

function isDateMode() {
  return Object.keys(dateCourses).length > 0
}

/**
 * 写入按日期直推的数据（**合并语义**）：
 * 手机每次只推「今天 ±14 天」窗口，逐日覆盖写入并保留窗口外的旧日期，
 * 累积覆盖随推送次数增长 —— 不改手机端也能翻看越来越多的天。
 * @param {object} data { days, week }
 */
function setDateSchedule(data) {
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
  trimDateCourses()
  hasSynced = true
  fullCourses = []
  fullSettings = null
  fullSectionTimes = {}
  snapshotWeek = 0
}

/** 日期条目超过上限时丢最旧的（键是 ISO 日期，字典序即时间序） */
function trimDateCourses() {
  const keys = Object.keys(dateCourses)
  if (keys.length <= DATE_KEEP_MAX) return
  keys.sort()
  while (keys.length > DATE_KEEP_MAX) {
    delete dateCourses[keys.shift()]
  }
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

/** 当前累积的按日期条目数（诊断展示用） */
function datedCount() {
  return Object.keys(dateCourses).length
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
  if (!data || !Array.isArray(data.courses)) {
    fullCourses = []
    fullSettings = null
    fullSectionTimes = {}
    return
  }
  // v4 整表是「全学期权威数据」：收到它就清掉旧的按日期条目与周归档。
  // 旧 APK（v3 按日期 ±14 天窗口）留下的条目优先级更高、且新 APK 不再推按日期数据，
  // 不清的话窗口内的调休/假期修正（如 10/10 补班）会被过期条目永久遮蔽。
  clearDateState()
  clearWeekArchive()
  const settings = normalizeFullSettings(data.settings)
  fullSettings = settings
  calibrateWeekOffset(settings)
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
  // 同上：保留按日期直推的数据，整周快照只代表它被推送那一刻的那一周
  const buckets = (data && data.week) || {}
  const settings = normalizeWeekSettings(data && data.settings, data && data.sentAt)
  /** 快照推送时间：决定它归档到哪一周 */
  const stampAt = toInt(data && data.sentAt, 0) || Date.now()
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
    // 归档这一周：手机只推「当前教学周」的分桶包，过去的做法是每周顶掉上一周，
    // 导致手环永远只有一周数据。按「快照所属周的周一」归档后，历史周永久可查。
    // 快照属于哪一周：手机推的就是它当时的当前教学周，用推送时间（sentAt）定位。
    archiveWeek(mondayKey(new Date(stampAt)), buckets, stampAt)
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
  calibrateWeekOffset(settings)
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
  weekOffset = 0
}

/**
 * 当前生效的教学周：**直接采用手机 payload 里给的值**（current_week / teachingWeek）。
 * 它只代表「推送那一刻」的本周，供兜底与界面标注；翻看其它日期时用 weekForDate 推算。
 */
function activeWeek() {
  if (fullSettings && fullSettings.currentWeek > 0) return fullSettings.currentWeek
  return snapshotWeek > 0 ? snapshotWeek : 0
}

/**
 * 整表模式下按日期推算教学周，公式与手机端
 * CourseScheduleDateBounds.calendarWeekForDate 完全一致：
 *   week = floorDiv(开学日到当天的天数 + (开学日星期-1), 7) + 1
 * 即第 1 周从「开学日所在周的周一」开始（周日起算的开学日，其周日属于第 1 周）。
 * 在此之上叠加 weekOffset 校准（见 calibrateWeekOffset）：
 * 手机端的实际教学周会把「调休合并周」（TeachingWeekReorganization）合并计数，
 * 日历公式不知道这些规则，合并周之后的周次会整体偏移 —— 用推送时刻手机给的
 * current_week 校准后，单双周在合并周之后不再翻转。
 * 推算不出（未下发/日期在第一周周一之前）返回 0，调用方回退到 activeWeek()。
 */
function weekForDate(date) {
  if (!fullSettings || !fullSettings.semesterStart) return 0
  const base = calendarWeekFor(date, fullSettings.semesterStart)
  if (base <= 0) return 0
  const week = base + weekOffset
  return week >= 1 ? week : 0
}

/** 日历周（不含校准）：第 1 周从开学日所在周的周一开始 */
function calendarWeekFor(date, start) {
  const d = date instanceof Date ? date : parseYmd(date)
  if (!d || !start) return 0
  const days = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()) /
      86400000
  )
  // JS getDay(): 0=周日；手机端 ISO dayOfWeek.value: 周一=1..周日=7，偏移取 value-1
  const startMondayOffset = start.getDay() === 0 ? 6 : start.getDay() - 1
  return Math.floor((days + startMondayOffset) / 7) + 1
}

/**
 * 用推送时刻手机给的 current_week 校准周次偏移：
 * offset = current_week - 日历推算周（限制 ±2，防异常值把全部周次带偏）。
 * 无调休合并周且开学日语义一致时 offset=0，行为不变。
 */
function calibrateWeekOffset(settings) {
  weekOffset = 0
  if (!settings || !settings.semesterStart || settings.currentWeek <= 0) return
  const cal = calendarWeekFor(new Date(), settings.semesterStart)
  const off = settings.currentWeek - cal
  if (off >= -2 && off <= 2) weekOffset = off
}

/** 整表模式是否具备「渲染学期内任意一天」的条件（有课表且有学期起始日） */
function hasFullSemester() {
  return !!(fullSettings && fullSettings.semesterStart && fullCourses.length)
}

function weekTextFor(date, realNow) {
  if (isDateMode()) {
    const entry = dateCourses[dateKey(date)]
    const w = entry && entry.week > 0 ? entry.week : dateWeekFallback
    return w > 0 ? '第' + w + '周' : ''
  }
  const computed = weekForDate(date)
  if (computed > 0) return '第' + computed + '周'
  const week = activeWeek()
  if (week <= 0) return ''
  // 无法按日期推算周次时，只有「当前这一周」能确认周数；
  // 归档的历史周/未知的其它周不乱标（过去会把当前周数标到所有日期上）
  if (mondayKey(date) === mondayKey(realNow || new Date())) return '第' + week + '周'
  return ''
}

/**
 * 与手机端 Course.isActiveInWeek 逐分支一致（严格语义）：
 * selectedWeeks 优先；周次边界用原始值比较 —— endWeek=0（教务导入未解析出周次）的课
 * 在手机端任何一周都不显示，这里必须同样隐藏，否则非本周课程会泄漏显示。
 */
function isCourseActiveInWeek(c, week) {
  if (c.selectedWeeks && c.selectedWeeks.length) {
    for (let i = 0; i < c.selectedWeeks.length; i++) {
      if (c.selectedWeeks[i] === week) return true
    }
    return false
  }
  if (week < c.startWeek || week > c.endWeek) return false
  if (c.weekType === 1) return week % 2 === 1
  if (c.weekType === 2) return week % 2 === 0
  return true
}

/**
 * 某天查课用的教学周。
 * 与手机端一致：调休条目带 followWeek(>0) 时，补的是「那一周」的课，
 * 而不是补班日所在周的课（CourseReminderHelper: displayWeek = followWeek ?: liveWeek）。
 * 其余日期优先按学期起始日推算（整表模式），推算不出回退手机给的 current_week。
 */
function lookupWeekFor(date) {
  const swap = findWorkSwap(date)
  if (swap && swap.followWeek > 0) return swap.followWeek
  const computed = weekForDate(date)
  if (computed > 0) return computed
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
  // 按日期直推优先：手机逐日解析好的数据对「这一天」最权威
  // （单双周、选周、调休、假期都在手机端算完），只按有没有这一天的条目判断；
  // 条目里课程为空也表示「这天确实没课」，不能再去套别的周。
  const key = dateKey(date)
  if (Object.prototype.hasOwnProperty.call(dateCourses, key)) {
    return dateCourses[key].courses.slice()
  }
  // 没覆盖到这一天（超出手机推送窗口）才退回周归档 / 推断 / 整表 / 当前周快照
  const day = resolveDisplayDayKey(date)
  if (day < 0) return []
  // 周归档优先于整表：手机逐周推送的真实数据比手环推算的更权威
  const archived = weekArchive[mondayKey(date)]
  if (archived) {
    return (archived.week[day] || []).slice()
  }
  // 单双周推断：≥2 个不同周的观测时，按规律补全未覆盖的周
  //（修复「该显示双周课的日子显示单周课」—— 快照周奇偶被套到所有日期上）
  const inferred = inferCoursesForDate(date, day)
  if (inferred) return inferred
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
    weekText: weekTextFor(date, now),
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
  clearWeekArchive,
  archiveCount,
  getWeekArchive,
  restoreWeekArchive,
  isDateMode,
  datedCount,
  hasDateFor,
  getDateCache,
  clearWeekState,
  isFullMode,
  hasFullSemester,
  weekForDate,
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
