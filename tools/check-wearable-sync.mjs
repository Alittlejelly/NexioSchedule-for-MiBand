/**
 * 手表端 × 手机端（Nexio 课程表 APK）通信回归检查
 *
 * 覆盖：
 *   1. 协议兼容：按周分桶（键 0-6 / 1-7）、整表（courses+settings+times）、
 *      按日期直推（days 数组 / map）、data 包裹 —— 各种下发格式都要能解析
 *   2. 周次：只采用手机给的值（current_week / teachingWeek），手环不按日期自算
 *   3. 周次规则：selectedWeeks / weekType 单双周 / startWeek-endWeek 范围
 *   4. 假期与调休：假期优先隐藏、调休按 followWeek 补对应周的课、
 *      followWeekday 未配置时回退当天、7 与 0 都按周日
 *   5. 时间：优先用手机给的 startTime/endTime，其次按 times 解析全局节次号
 *   6. 缓存：推过一次后冷启动（无手机）仍能看到课表，且回放不会二次换算
 *
 * 用法：node tools/check-wearable-sync.mjs [真实课表.json]
 * 说明：直接用 src/common 下的真实代码，只把 @system.interconnect /
 *      @system.storage 换成内存桩；不依赖 aiot-toolkit，也不需要设备。
 *      可选传入手机导出的课表 JSON 做端到端校验。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 本工程源码目录 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/common')
/** 临时工作目录放系统临时区，避免污染仓库 */
const WORKROOT = path.join(os.tmpdir(), 'nexio-watch-check')
/** 可选：真实课表 JSON（命令行参数或环境变量） */
const REAL = process.argv[2] || process.env.NEXIO_REAL_SCHEDULE || ''

const PROJECTS = [{ tag: 'watch', src: SRC }]

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

// ---------------------------------------------------------------- 手机端组包
const COURSE = (id, name, s, e) => ({
  id, name, startTime: s, endTime: e, periods: '第1-2节', location: 'A101', teacher: '张老师'
})
const WEEK = {
  0: [COURSE('c-sun', '形势与政策', '19:00', '20:30')],
  1: [COURSE('c1', '高等数学', '08:00', '09:40'), COURSE('c2', '大学英语', '10:00', '11:40')],
  2: [COURSE('c3', '数据结构', '08:00', '09:40')],
  3: [COURSE('c4', '计算机网络', '10:00', '11:40')],
  4: [COURSE('c5', '离散数学', '14:00', '15:40')],
  5: [COURSE('c6', '编译原理', '08:00', '09:40')],
  6: [COURSE('c7', '物理实验', '10:00', '11:40')]
}
const HOLIDAYS = [
  { date: '2026-10-01', endDate: '2026-10-07', name: '国庆节', type: 0, followWeek: -1, followWeekday: -1, custom: false },
  { date: '2026-10-10', endDate: '', name: '补班', type: 1, followWeek: 6, followWeekday: 1, custom: false },
  { date: '2026-10-11', endDate: '', name: '补班', type: 1, followWeek: 6, followWeekday: -1, custom: false },
  { date: '2026-10-05', endDate: '', name: '假期内补班', type: 1, followWeek: 6, followWeekday: 2, custom: false },
  { date: '2026-10-17', endDate: '', name: '补班', type: 1, followWeek: 7, followWeekday: 7, custom: false },
  { date: '2026-10-24', endDate: '', name: '补班0', type: 1, followWeek: 7, followWeekday: 0, custom: false }
]

/** v1：手表域 week 键 0-6（0=周日） */
function payloadV1() {
  const week = {}
  for (let i = 0; i <= 6; i++) week[String(i)] = WEEK[i]
  return { protocol: 'nexio.schedule', version: 1, action: 'replace', sentAt: 1760000000000, scheduleName: '默认课表', holidays: HOLIDAYS, week }
}

/** v2：手机域 week 键 1-7（1=周一 … 7=周日） */
function payloadV2() {
  const week = {}
  for (let i = 0; i <= 6; i++) week[String(i === 0 ? 7 : i)] = WEEK[i]
  return { protocol: 'nexio.schedule', version: 2, action: 'replace', holidays: HOLIDAYS, week }
}

/** 升了版本号但键仍是手表域 0-6 —— 旧实现会整包拒绝，必须也能解析 */
function payloadV2KeepWatchKeys() {
  const week = {}
  for (let i = 0; i <= 6; i++) week[String(i)] = WEEK[i]
  return { protocol: 'nexio.schedule', version: 2, action: 'replace', holidays: HOLIDAYS, week }
}

/** 未知版本：键自描述，按 0-6 解析即可，不应该整包丢弃 */
function payloadUnknownVersion() {
  const week = {}
  for (let i = 0; i <= 6; i++) week[String(i)] = WEEK[i]
  return { protocol: 'nexio.schedule', version: 9, action: 'replace', holidays: HOLIDAYS, week }
}

/** days[] 形式：weekday 用 0 表示周日 */
function payloadDays() {
  return {
    protocol: 'nexio.schedule',
    version: 1,
    action: 'replace',
    days: [
      { date: '2026-10-12', weekday: 1, courses: WEEK[1] },
      { date: '2026-10-18', weekday: 0, courses: WEEK[0] }
    ]
  }
}

/**
 * 整表模式 fixture：与手机端 buildShareScheduleMap 同结构
 * （settings.class_start_time=2026/09/13 周日；上午 6 节 / 下午 5 节 / 晚上 3 节，节次号全局 1..14）
 */
const FULL_TIMES = {
  morning: { 1: '08:00-08:40', 2: '08:50-09:30', 3: '09:40-10:20', 4: '10:30-11:10', 5: '11:20-12:00', 6: '12:10-14:30' },
  afternoon: { 1: '14:40-15:20', 2: '15:30-16:10', 3: '16:20-17:00', 4: '17:10-17:50', 5: '18:00-18:40' },
  evening: { 1: '19:30-20:10', 2: '20:20-21:00', 3: '21:10-21:50' },
  section_names: {}
}
const FULL_COURSES = [
  { name: '高等数学', classroom: 'A101', teacher: '张老师', dayOfWeek: 1, startSection: 1, endSection: 2, isCustomTime: false, startWeek: 2, endWeek: 12, weekType: 0, selectedWeeks: [] },
  { name: '单周物理', classroom: 'B202', teacher: '李老师', dayOfWeek: 1, startSection: 3, endSection: 4, isCustomTime: false, startWeek: 1, endWeek: 18, weekType: 1, selectedWeeks: [] },
  { name: '双周化学', classroom: 'C303', teacher: '王老师', dayOfWeek: 2, startSection: 1, endSection: 2, isCustomTime: false, startWeek: 1, endWeek: 18, weekType: 2, selectedWeeks: [] },
  { name: '选修课', classroom: 'D404', teacher: '赵老师', dayOfWeek: 2, startSection: 7, endSection: 8, isCustomTime: false, startWeek: 2, endWeek: 14, weekType: 0, selectedWeeks: [2, 3, 4, 6, 7] },
  { name: '晚自习课', classroom: 'E505', teacher: '钱老师', dayOfWeek: 3, startSection: 12, endSection: 14, isCustomTime: true, customStartTime: '19:30', customEndTime: '20:30', startWeek: 1, endWeek: 18, weekType: 0, selectedWeeks: [] },
  { name: '体育', classroom: '田径场', teacher: '孙老师', dayOfWeek: 4, startSection: 7, endSection: 9, isCustomTime: false, startWeek: 1, endWeek: 18, weekType: 0, selectedWeeks: [] },
  { name: '期末讲座', classroom: '报告厅', teacher: '周老师', dayOfWeek: 4, startSection: 1, endSection: 2, isCustomTime: false, startWeek: 10, endWeek: 10, weekType: 0, selectedWeeks: [] }
]
/** 真实「今天」相对 fixture 学期（2026/09/13 周日开学）的日历周。
 *  整表 fixture 的 current_week 用它生成 → 周次校准偏移恒为 0，用例不随运行日期漂移 */
const CAL_WEEK_TODAY = Math.max(
  1,
  Math.floor(
    (Math.round(
      new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() -
        new Date(2026, 8, 13).getTime()
    ) /
      86400000 +
      6) /
      7
  ) + 1
)

function payloadFull() {
  return {
    protocol: 'nexio.schedule',
    version: 4,
    schedule_name: '测试课表',
    settings: {
      class_start_time: '2026/09/13',
      current_week: CAL_WEEK_TODAY,
      total_weeks: 18,
      morning_sections: 6,
      afternoon_sections: 5,
      evening_sections: 3,
      teaching_week_reorganizations: { schema_version: 1, rules: [] }
    },
    times: FULL_TIMES,
    courses: FULL_COURSES,
    holidays: [
      { date: '2026-10-10', endDate: '', name: '补班', type: 1, followWeek: 5, followWeekday: 1, custom: false },
      { date: '2026-10-06', endDate: '', name: '调休放假', type: 0, followWeek: -1, followWeekday: -1, custom: false }
    ]
  }
}

/** v2 变体 A：整表内容包一层 data 对象 */
function payloadFullNested() {
  return { protocol: 'nexio.schedule', version: 2, action: 'replace', data: payloadFull() }
}

/** v2 变体 B：week 桶 + 每门课带周次字段 + 顶层 teachingWeek（表示未按周过滤，手环自己过滤） */
function payloadBucketsWithWeeks() {
  const week = {}
  for (let d = 0; d <= 6; d++) week[String(d)] = []
  for (const c of FULL_COURSES) {
    const day = c.dayOfWeek === 7 ? 0 : c.dayOfWeek
    week[String(day)].push({
      name: c.name,
      classroom: c.classroom,
      teacher: c.teacher,
      startSection: c.startSection,
      endSection: c.endSection,
      isCustomTime: c.isCustomTime,
      customStartTime: c.customStartTime,
      customEndTime: c.customEndTime,
      startWeek: c.startWeek,
      endWeek: c.endWeek,
      weekType: c.weekType,
      selectedWeeks: c.selectedWeeks
    })
  }
  return {
    protocol: 'nexio.schedule',
    version: 2,
    action: 'replace',
    teachingWeek: 4,
    total_weeks: 18,
    class_start_time: '2026/09/13',
    morning_sections: 6,
    afternoon_sections: 5,
    evening_sections: 3,
    times: FULL_TIMES,
    week: week,
    holidays: payloadFull().holidays
  }
}

/** v2 变体 C：手机已按当前周过滤的桶（课不带周次字段）+ teachingWeek（仅用于标注） */
function payloadBucketsFiltered() {
  return {
    protocol: 'nexio.schedule',
    version: 2,
    action: 'replace',
    teachingWeek: 5,
    total_weeks: 18,
    week: {
      1: [{ name: '周一课', startTime: '08:00', endTime: '09:40', periods: '第1-2节', location: 'A101', teacher: '张老师' }]
    }
  }
}

/** 方案2：手机按日期推「每天已解析好的课表」，手环纯映射渲染 */
function payloadDates() {
  return {
    protocol: 'nexio.schedule',
    version: 3,
    action: 'replace',
    week: 4,
    days: [
      { date: '2026-10-05', week: 4, courses: [] },
      { date: '2026-10-06', week: 4, courses: [] },
      { date: '2026-10-07', week: 4, holiday: '调休放假', isHoliday: true, courses: [] },
      {
        date: '2026-10-08',
        week: 4,
        courses: [
          { name: '传感技术及应用', startTime: '14:40', endTime: '17:50', period: 'afternoon', periods: '第7-10节', location: 'A10-310', teacher: '李保民' }
        ]
      },
      { date: '2026-10-09', week: 4, courses: [] },
      {
        date: '2026-10-10',
        week: 4,
        isWorkSwap: true,
        courses: [
          { name: '工匠精神的实践与养成', startTime: '16:20', endTime: '17:50', period: 'afternoon', periods: '第9-10节', location: 'A1-东401', teacher: '李言溪' }
        ]
      },
      { date: '2026-10-11', week: 4, courses: [] }
    ]
  }
}

/** 方案2 的 map 形式：{ '2026-10-10': [课程...] } */
function payloadDatesMap() {
  return {
    protocol: 'nexio.schedule',
    version: 3,
    action: 'replace',
    week: 4,
    days: {
      '2026-10-10': [
        { name: '工匠精神的实践与养成', startTime: '16:20', endTime: '17:50', period: 'afternoon', periods: '第9-10节', location: 'A1-东401', teacher: '李言溪' }
      ]
    }
  }
}

/** 整表模式：周次公式 + 单双周/选周/周范围过滤 + 自定义时间 + 节次时间 + 假期/调休 */
/**
 * 整表模式：周次按「开学日所在周的周一」逐日推算（与手机端 calendarWeekForDate 一致，
 * fixture 开学日 2026/09/13 为周日 → 第 1 周是 09/07-09/13，09/14 起是第 2 周）。
 * 调休日仍按手机给的 followWeek 优先（fixture 里是 5）。
 */
const FULL_CASES = [
  { date: '2026-09-14', week: 2, names: ['高等数学'], section: ['morning'] },
  { date: '2026-09-21', week: 3, names: ['高等数学', '单周物理'], section: ['morning', 'morning'], note: '第3周 单周物理生效' },
  { date: '2026-09-15', week: 2, names: ['双周化学', '选修课'], section: ['morning', 'afternoon'] },
  { date: '2026-09-29', week: 4, names: ['双周化学', '选修课'], section: ['morning', 'afternoon'] },
  { date: '2026-10-07', week: 5, names: ['晚自习课'], section: ['evening'] },
  { date: '2026-10-08', week: 5, names: ['体育'], section: ['afternoon'] },
  { date: '2026-10-10', week: 5, names: ['高等数学', '单周物理'], section: ['morning', 'morning'], note: '周六补班→周一课(手机给 followWeek=5)' },
  { date: '2026-10-11', week: 5, names: [], section: [] },
  { date: '2026-10-12', week: 6, names: ['高等数学'], section: ['morning'], note: '第6周 单周物理不生效' },
  { date: '2026-11-12', week: 10, names: ['期末讲座', '体育'], section: ['morning', 'afternoon'], note: '只在第10周出现的课要出现' }
]
const FULL_WEEKS = [4]

const localDate = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const STUB_INTERCONNECT = `export default {
  instance() {
    return {
      send(o) { (globalThis.__sent = globalThis.__sent || []).push(o && o.data); o && o.success && o.success() },
      getReadyState(o) { o && o.fail && o.fail({}, 1) },
      onmessage: null, onopen: null, onclose: null, onerror: null
    }
  }
}`

/** 内存版 storage：真实模拟「set 后能 get 回来」，并可切成 {key,value} 包装形态 */
const STUB_STORAGE = `const store = (globalThis.__store = globalThis.__store || {});
export default {
  set(o) { if (o.value) store[o.key] = o.value; o && o.success && o.success() },
  get(o) {
    const v = store[o.key];
    if (v == null) { o && o.fail && o.fail({}, 1); return }
    if (globalThis.__wrapGet) { o && o.success && o.success({ key: o.key, value: v }); return }
    o && o.success && o.success(v)
  }
}`

/** 记录 showToast 调用，连接 toast 的回归检查用 */
const STUB_PROMPT = `export default {
  showToast(o) { (globalThis.__toasts = globalThis.__toasts || []).push(o && o.message) }
}`

let dirSeq = 0
async function loadProject(src) {
  const dir = path.join(WORKROOT, 'w' + dirSeq++)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  fs.writeFileSync(path.join(dir, '__stub-interconnect.js'), STUB_INTERCONNECT)
  fs.writeFileSync(path.join(dir, '__stub-storage.js'), STUB_STORAGE)
  fs.writeFileSync(path.join(dir, '__stub-prompt.js'), STUB_PROMPT)
  const rewrite = (js) => js
    .replace(/from '@system\.interconnect'/g, "from './__stub-interconnect.js'")
    .replace(/from '@system\.storage'/g, "from './__stub-storage.js'")
    .replace(/from '@system\.prompt'/g, "from './__stub-prompt.js'")
    .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'")
  for (const f of ['schedule.js', 'util.js', 'sync.js']) {
    fs.writeFileSync(path.join(dir, f), rewrite(fs.readFileSync(path.join(src, f), 'utf8')))
  }
  const load = async (f) => (await import(pathToFileURL(path.join(dir, f)).href)).default
  return { dir, schedule: await load('schedule.js'), util: await load('util.js'), sync: await load('sync.js') }
}

const courseNames = (vm) => vm.groups.reduce((a, g) => a.concat(g.courses.map((c) => c.name)), [])
function view(schedule, util, dateStr) {
  const date = localDate(dateStr)
  const now = localDate(dateStr)
  now.setHours(21, 0, 0, 0)
  return schedule.buildHomeViewModel(date, util, now)
}

fs.rmSync(WORKROOT, { recursive: true, force: true })
fs.mkdirSync(WORKROOT, { recursive: true })

const DAY_CASES = [
  { date: '2026-10-12', label: '普通周一', names: ['高等数学', '大学英语'], empty: 'none' },
  { date: '2026-10-08', label: '普通周四', names: ['离散数学'], empty: 'none' },
  { date: '2026-10-06', label: '国庆假期内（周二）', names: [], empty: 'holiday' },
  { date: '2026-10-05', label: '假期内的补班条目（假期应优先隐藏）', names: [], empty: 'holiday' },
  { date: '2026-10-10', label: '周六补班 → 上周一课', names: ['高等数学', '大学英语'], empty: 'none' },
  { date: '2026-10-11', label: '周日补班未配 followWeekday → 退回日历星期', names: ['形势与政策'], empty: 'none' },
  { date: '2026-10-17', label: '周六补班 → 上周日课（7 映射到 0）', names: ['形势与政策'], empty: 'none' },
  { date: '2026-10-24', label: '周六补班 → 上周日课（followWeekday=0 容错）', names: ['形势与政策'], empty: 'none' }
]

for (const p of PROJECTS) {
  console.log(`\n===== ${p.tag} =====`)

  // ---- 1. 各协议变体结果必须一致，且与预期一致 ----
  const VARIANTS = [
    { label: 'version=1 + 手表域键 0-6（当前手机端 WatchPayload）', payload: payloadV1() },
    { label: 'version=2 + 手机域键 1-7', payload: payloadV2() },
    { label: 'version=2 + 手表域键 0-6（升版本但键没换）', payload: payloadV2KeepWatchKeys() },
    { label: '未知版本号 + 手表域键 0-6（按键自描述解析）', payload: payloadUnknownVersion() }
  ]
  for (const v of VARIANTS) {
    const inst = await loadProject(p.src)
    const r = inst.sync.handlePhoneMessage(v.payload)
    const bad = DAY_CASES.filter((c) => {
      const vm = view(inst.schedule, inst.util, c.date)
      return courseNames(vm).join(',') !== c.names.join(',') || vm.emptyState !== c.empty
    })
    check(v.label, r.ok && bad.length === 0,
      r.ok ? (bad.length ? '不符：' + bad.map((b) => b.date).join(',') : `${inst.schedule.getHolidays().length} 条假期/调休`) : r.error)
  }

  // ---- 2. days[] 形式（weekday=0 表示周日）----
  const days = await loadProject(p.src)
  const rd = days.sync.handlePhoneMessage(payloadDays())
  const mon = courseNames(view(days.schedule, days.util, '2026-10-12')).join(',')
  const sun = courseNames(view(days.schedule, days.util, '2026-10-18')).join(',')
  check('days[] 形式（weekday 0/1）', rd.ok && mon === '高等数学,大学英语' && sun === '形势与政策',
    rd.ok ? `周一=[${mon}] 周日=[${sun}]` : rd.error)

  // ---- 3. 整表模式：手环自己算周次 + 按周次规则过滤 ----
  const full = await loadProject(p.src)
  const rf = full.sync.handlePhoneMessage(payloadFull())
  check('接受整表 payload（courses + settings + times）', rf.ok, rf.ok ? rf.shape : rf.error)
  check('activeWeek 保留手机给的 current_week（兜底/标注用）',
    full.schedule.activeWeek() === CAL_WEEK_TODAY, '实际 ' + full.schedule.activeWeek())
  for (const c of FULL_CASES) {
    const vm = view(full.schedule, full.util, c.date)
    const got = courseNames(vm)
    const secs = vm.groups.reduce((a, g) => a.concat(g.courses.map((x) => x.section)), [])
    check(`${c.date} 第${c.week}周${c.note ? ' ' + c.note : ''}`,
      got.join(',') === c.names.join(',') && secs.join(',') === c.section.join(','),
      `课程=[${got.join(', ')}] 时段=[${secs.join(', ')}] ${vm.weekText}`)
  }
  check('周次标注按日期推算（09-14=第2周，11-12=第10周）',
    view(full.schedule, full.util, '2026-09-14').weekText === '第2周' &&
      view(full.schedule, full.util, '2026-11-12').weekText === '第10周',
    `09-14=${view(full.schedule, full.util, '2026-09-14').weekText} 11-12=${view(full.schedule, full.util, '2026-11-12').weekText}`)
  // 手机没给 class_start_time 时不能空：回退 current_week（兼容旧整表包）
  const vNoStart = await loadProject(p.src)
  const pNoStart = payloadFull()
  delete pNoStart.settings.class_start_time
  pNoStart.settings.current_week = 4
  vNoStart.sync.handlePhoneMessage(pNoStart)
  check('整表缺 class_start_time → 回退 current_week（14日按第4周过滤）',
    courseNames(view(vNoStart.schedule, vNoStart.util, '2026-09-14')).join(',') === '高等数学',
    `周一=[${courseNames(view(vNoStart.schedule, vNoStart.util, '2026-09-14')).join(',')}]`)
  // 整表周次校准：手机 current_week 与日历周不一致时（如调休合并周少算一周），偏移被吸收，
  // 单双周在合并周之后不再整体翻转。期望值按「今天」的日历周动态计算，用例不随日期漂移。
  const vCal = await loadProject(p.src)
  const pCal = payloadFull()
  pCal.settings.current_week = 3
  vCal.sync.handlePhoneMessage(pCal)
  const calToday =
    Math.floor(
      (Math.round(
        new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() -
          new Date(2026, 8, 13).getTime()
      ) /
        86400000 +
        6) /
        7
    ) + 1
  const off = 3 - calToday >= -2 && 3 - calToday <= 2 ? 3 - calToday : 0
  const expectWeek = Math.max(1, 5 + off)
  check('整表周次校准：current_week=3 的偏移被吸收（10-07 周次=日历周+off）',
    view(vCal.schedule, vCal.util, '2026-10-07').weekText === '第' + expectWeek + '周',
    `实际=${view(vCal.schedule, vCal.util, '2026-10-07').weekText} 期望=第${expectWeek}周(日历5周+${off})`)
  // 整表模式下手环能自己算任意一周，收到整表后不应再向手机索要按日期数据
  globalThis.__store = {}
  globalThis.__sent = []
  const fullNoReq = await loadProject(p.src)
  fullNoReq.sync.init()
  fullNoReq.sync.handlePhoneMessage(payloadFull())
  fullNoReq.sync.ensureFresh('test')
  check('整表模式收到后不再向手机请求按日期数据',
    !globalThis.__sent.some((s) => s && s.action === 'request'),
    `已发送=${JSON.stringify(globalThis.__sent)}`)
  const wed = view(full.schedule, full.util, '2026-10-07').groups[0].courses[0]
  check('自定义时间课按 customStartTime/EndTime', wed.timeText === '19:30 - 20:30', wed.timeText)
  const thu = view(full.schedule, full.util, '2026-10-08').groups[0].courses[0]
  check('节次时间按 times 解析（第7-9节 → 14:40-17:00）',
    thu.timeText === '14:40 - 17:00' && thu.meta.indexOf('第7-9节') === 0, thu.timeText + ' | ' + thu.meta)
  const hol = view(full.schedule, full.util, '2026-10-06')
  check('整表模式假期仍然隐藏课程', courseNames(hol).length === 0 && hol.emptyState === 'holiday', hol.emptyState)

  // ---- 4. 整表模式的缓存 ----
  globalThis.__store = {}
  const hotFull = await loadProject(p.src)
  hotFull.sync.handlePhoneMessage(payloadFull())
  const fullCacheSize = (globalThis.__store['nexio.schedule.payload'] || '').length
  const coldFull = await loadProject(p.src)
  coldFull.sync.init()
  await new Promise((r) => setTimeout(r, 30))
  const coldVm = view(coldFull.schedule, coldFull.util, '2026-09-29')
  check('整表缓存：冷启动后周次与课表都还原',
    courseNames(coldVm).join(',') === '双周化学,选修课' && coldFull.schedule.activeWeek() === CAL_WEEK_TODAY,
    `缓存 ${fullCacheSize} 字节，课程=[${courseNames(coldVm).join(', ')}] week=${coldFull.schedule.activeWeek()}`)

  // ---- 5. 兼容手机 v2 的几种可能形状 ----
  const vA = await loadProject(p.src)
  const rA = vA.sync.handlePhoneMessage(payloadFullNested())
  const aOk = FULL_CASES.every((c) => courseNames(view(vA.schedule, vA.util, c.date)).join(',') === c.names.join(','))
  check('v2-A：整表包一层 data 对象', rA.ok && aOk, rA.ok ? rA.shape : rA.error)

  const vB = await loadProject(p.src)
  const rB = vB.sync.handlePhoneMessage(payloadBucketsWithWeeks())
  const bOk = FULL_CASES.every((c) => {
    const vm = view(vB.schedule, vB.util, c.date)
    const secs = vm.groups.reduce((a2, g) => a2.concat(g.courses.map((x) => x.section)), [])
    return courseNames(vm).join(',') === c.names.join(',') && secs.join(',') === c.section.join(',')
  })
  check('v2-B：桶+每课周次+teachingWeek → 手环自己按周过滤', rB.ok && bOk, rB.ok ? rB.shape : rB.error)

  const vC = await loadProject(p.src)
  const rC = vC.sync.handlePhoneMessage(payloadBucketsFiltered())
  const cVm = view(vC.schedule, vC.util, '2026-10-05')
  check('v2-C：已过滤桶 + teachingWeek → 标注周次',
    rC.ok && cVm.weekText === '第5周' && courseNames(cVm).join(',') === '周一课',
    rC.ok ? `${rC.shape} weekText=${cVm.weekText}` : rC.error)

  // 调休 followWeek：补的是「那一周」的课，而不是补班日所在周的课
  const vD = await loadProject(p.src)
  const pD = payloadFull()
  pD.holidays[0].followWeek = 4
  vD.sync.handlePhoneMessage(pD)
  const dSat = courseNames(view(vD.schedule, vD.util, '2026-10-10')).join(',')
  check('调休按 followWeek 查课（followWeek=4 时单周物理不该出现）', dSat === '高等数学', `周六=[${dSat}]`)

  // 周次缺失/单边周次（教务导入缺陷数据）：与手机端 isActiveInWeek 严格语义一致 —— 一律隐藏
  const vE = await loadProject(p.src)
  const pE = payloadFull()
  pE.courses = [
    { name: '无周次课', classroom: 'X', teacher: 'Y', dayOfWeek: 1, startSection: 1, endSection: 2, weekType: 0 },
    { name: '只有起始周', classroom: 'X', teacher: 'Y', dayOfWeek: 1, startSection: 3, endSection: 4, startWeek: 5, endWeek: 0, weekType: 0 },
    { name: '只有结束周', classroom: 'X', teacher: 'Y', dayOfWeek: 1, startSection: 5, endSection: 6, startWeek: 0, endWeek: 8, weekType: 0 }
  ]
  vE.sync.handlePhoneMessage(pE)
  // 2026-10-12 属第 6 周：无周次课(0..0)隐藏；只有起始周(5..0)隐藏；只有结束周(0..8)第6周在界内显示
  const eMon = courseNames(view(vE.schedule, vE.util, '2026-10-12')).join(',')
  check('周次缺失/单边周次的课与手机端一致地隐藏/显示',
    eMon === '只有结束周', `周一=[${eMon}]`)

  // 时间解析不出（startTime/endTime 都为空）但带节次文案的课不能整条丢弃 —— 「偶尔缺课」根因之一
  const vT = await loadProject(p.src)
  const pT = payloadV1()
  pT.week[1] = pT.week[1].concat([
    { id: 'c-notime', name: '无时间课', startTime: '', endTime: '', periods: '第13-14节', location: 'Z909', teacher: '助教' }
  ])
  const rT = vT.sync.handlePhoneMessage(pT)
  const tMon = courseNames(view(vT.schedule, vT.util, '2026-10-12')).join(',')
  check('时间解析不出的课保留（不再整条丢弃）', rT.ok && tMon.indexOf('无时间课') >= 0, `周一=[${tMon}]`)

  // 手机端 WatchPayload.buildFullJson 的原始输出形态（version=4，location 字段，无 periods）：
  // 与 Kotlin 组包逐字段对齐，防止两边字段名漂移
  const vK = await loadProject(p.src)
  const rK = vK.sync.handlePhoneMessage({
    protocol: 'nexio.schedule',
    version: 4,
    action: 'replace',
    sentAt: 1790000000000,
    schedule_name: '默认课表',
    settings: { class_start_time: '2026/09/13', current_week: CAL_WEEK_TODAY, total_weeks: 18, morning_sections: 6, afternoon_sections: 5, evening_sections: 3 },
    times: FULL_TIMES,
    courses: [
      { id: 'k1', name: 'Kotlin高数', dayOfWeek: 1, startSection: 1, endSection: 2, startWeek: 2, endWeek: 12, weekType: 0, selectedWeeks: [], isCustomTime: false, customStartTime: '', customEndTime: '', location: 'K101', teacher: '张老师' },
      { id: 'k2', name: 'Kotlin晚课', dayOfWeek: 3, startSection: 12, endSection: 14, startWeek: 1, endWeek: 18, weekType: 0, selectedWeeks: [], isCustomTime: true, customStartTime: '19:30', customEndTime: '20:30', location: 'K505', teacher: '钱老师' }
    ],
    holidays: []
  })
  const kMon = view(vK.schedule, vK.util, '2026-09-21')
  const kWed = view(vK.schedule, vK.util, '2026-10-07')
  check('buildFullJson 形态：整表接受且按周推算（第3周周一）',
    rK.ok && courseNames(kMon).join(',') === 'Kotlin高数' && kMon.weekText === '第3周',
    `课程=[${courseNames(kMon).join(',')}] ${kMon.weekText}`)
  check('buildFullJson 形态：地点用 location、自定义时间直读',
    kMon.groups[0].courses[0].meta.indexOf('K101') >= 0 &&
      kWed.groups[0].courses[0].timeText === '19:30 - 20:30',
    `周一meta=[${kMon.groups[0].courses[0].meta}] 周三=[${kWed.groups[0].courses[0].timeText}]`)

  // ---- 方案2：按日期直推，手环纯映射 ----
  const vF = await loadProject(p.src)
  const rF = vF.sync.handlePhoneMessage(payloadDates())
  const fSat = view(vF.schedule, vF.util, '2026-10-10')
  const fSatC = fSat.groups.reduce((a, g) => a.concat(g.courses), [])[0] || {}
  const fThu = view(vF.schedule, vF.util, '2026-10-08')
  const fThuC = fThu.groups.reduce((a, g) => a.concat(g.courses), [])[0] || {}
  const fWed = view(vF.schedule, vF.util, '2026-10-07')
  check('方案2：按日期直推（含时段/节次/时间原样映射）',
    rF.ok &&
      courseNames(fSat).join(',') === '工匠精神的实践与养成' &&
      fSatC.timeText === '16:20 - 17:50' &&
      fSatC.meta.indexOf('第9-10节') === 0 &&
      fSatC.section === 'afternoon' &&
      courseNames(fThu).join(',') === '传感技术及应用' &&
      fThuC.meta.indexOf('第7-10节') === 0,
    rF.ok ? `${rF.shape} 周六=[${courseNames(fSat).join(',')} ${fSatC.timeText} ${fSatC.meta}]` : rF.error)
  check('方案2：手机标为假期的日期 → 空态是假期',
    courseNames(fWed).length === 0 && fWed.emptyState === 'holiday' && fWed.isHoliday,
    `empty=${fWed.emptyState} isHoliday=${fWed.isHoliday}`)
  check('方案2：周次标注用手机给的值', fSat.weekText === '第4周', fSat.weekText)

  const vG = await loadProject(p.src)
  const rG = vG.sync.handlePhoneMessage(payloadDatesMap())
  check('方案2：days 用 map 形式也能映射',
    rG.ok && courseNames(view(vG.schedule, vG.util, '2026-10-10')).join(',') === '工匠精神的实践与养成',
    rG.ok ? rG.shape : rG.error)

  // 方案2 的缓存
  globalThis.__store = {}
  const hotDates = await loadProject(p.src)
  hotDates.sync.handlePhoneMessage(payloadDates())
  const coldDates = await loadProject(p.src)
  coldDates.sync.init()
  await new Promise((r) => setTimeout(r, 30))
  const coldSat = view(coldDates.schedule, coldDates.util, '2026-10-10')
  check('方案2：冷启动后按日期数据仍在',
    courseNames(coldSat).join(',') === '工匠精神的实践与养成' && coldSat.weekText === '第4周',
    `周六=[${courseNames(coldSat).join(',')}] ${coldSat.weekText}`)

  // ---- 6. 缓存：手机推过之后冷启动 ----
  for (const kind of ['v1', 'v2']) {
    globalThis.__store = {}
    const hot = await loadProject(p.src)
    const pushed = hot.sync.handlePhoneMessage(kind === 'v1' ? payloadV1() : payloadV2())
    const cacheRaw = globalThis.__store['nexio.schedule.payload'] || ''
    check(`${kind}: 推送后写入缓存`, pushed.ok && cacheRaw.length > 0, `缓存 ${cacheRaw.length} 字节`)

    // 冷启动：新模块实例 + storage 保留 + 没有任何手机消息
    const cold = await loadProject(p.src)
    globalThis.__wrapGet = false
    cold.sync.init()
    await new Promise((r) => setTimeout(r, 30))
    const vm = view(cold.schedule, cold.util, '2026-10-10')
    check(`${kind}: 冷启动无手机可看课表`,
      cold.schedule.hasSyncedSchedule() && courseNames(vm).join(',') === '高等数学,大学英语',
      `hasSynced=${cold.schedule.hasSyncedSchedule()} 课程=[${courseNames(vm).join(', ')}] holidays=${cold.schedule.getHolidays().length}`)
    check(`${kind}: 冷启动不出现重新换算（周日课还在）`,
      courseNames(view(cold.schedule, cold.util, '2026-10-17')).join(',') === '形势与政策')

    // storage.get 返回 {key, value} 包装时也要能读
    const wrapped = await loadProject(p.src)
    globalThis.__wrapGet = true
    wrapped.sync.init()
    await new Promise((r) => setTimeout(r, 30))
    check(`${kind}: storage.get 返回 {key,value} 也能恢复`,
      courseNames(view(wrapped.schedule, wrapped.util, '2026-10-12')).length === 2)
    globalThis.__wrapGet = false
  }

  // ---- 7. 手机「导出到手环」的整周分桶包不能顶掉「按日期直推」数据 ----
  // 手机端两种包（其工程 wearable/WatchPayload.kt）：
  //   buildDaysJson：version=3 按日期直推（今天 ±14 天，逐日解析好）→ App 启动 / 手环 request 走这条
  //   buildWeekJson：version=1 整周分桶，**只含导出那一刻的当前教学周** → 设置页「导出到手环」走这条
  // 后者自身没有任何日期信息，若把手环已有的按日期数据清掉，其它周（单双周/选周）
  // 就会显示成那一周的内容 —— 这正是「手环只显示单周课、双周课不显示」的根因。
  {
    const pad = (n) => (n < 10 ? '0' + n : '' + n)
    const dateStrOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const today = new Date()
    const thisMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    thisMonday.setDate(thisMonday.getDate() - ((thisMonday.getDay() + 6) % 7))
    const nextMonday = new Date(thisMonday.getTime() + 7 * 86400000)
    const phoneDayOf = (d) => (d.getDay() === 0 ? 7 : d.getDay())

    const PHONE_COURSES = [
      { id: 'all', name: '全周课', dayOfWeek: 1, startSection: 1, startWeek: 1, endWeek: 18, weekType: 0, startTime: '08:00', endTime: '08:45', period: 'morning' },
      { id: 'even', name: '双周课', dayOfWeek: 1, startSection: 3, startWeek: 1, endWeek: 18, weekType: 2, startTime: '10:00', endTime: '10:45', period: 'morning' },
      { id: 'odd', name: '单周课', dayOfWeek: 1, startSection: 5, startWeek: 1, endWeek: 18, weekType: 1, startTime: '14:00', endTime: '14:45', period: 'afternoon' },
      { id: 'tue', name: '周二全周课', dayOfWeek: 2, startSection: 1, startWeek: 1, endWeek: 18, weekType: 0, startTime: '08:00', endTime: '08:45', period: 'morning' }
    ]
    const namesOf = (inst, dateStr) => courseNames(view(inst.schedule, inst.util, dateStr))

    /**
     * 造一次「手机侧」的两种包。weeksBack 只决定本学期从哪天开学，用来把「本周」
     * 摆成单周或双周 —— 两种情况都要覆盖（用户遇到的正是导出发生在单周）。
     */
    const phoneCase = (weeksBack, tag) => {
      const semesterMonday = new Date(thisMonday.getTime())
      semesterMonday.setDate(semesterMonday.getDate() - weeksBack * 7)
      const phoneWeek = (d) => Math.floor(Math.round((d - semesterMonday) / 86400000) / 7) + 1
      /** 与手机端 Course.isActiveInWeek 一致（weekType 1=单周 2=双周） */
      const active = (c, week) =>
        week >= c.startWeek && week <= c.endWeek &&
        (c.weekType === 1 ? week % 2 === 1 : c.weekType === 2 ? week % 2 === 0 : true)
      const coursesOn = (d) =>
        PHONE_COURSES.filter((c) => c.dayOfWeek === phoneDayOf(d) && active(c, phoneWeek(d)))
      const courseJson = (c) => ({
        id: c.id, name: c.name, startTime: c.startTime, endTime: c.endTime,
        period: c.period, periods: `第${c.startSection}节`, location: 'A101', teacher: '张老师'
      })
      /** 手机 WatchPayload.buildDaysJson：今天 ±14 天逐日解析好 */
      const dated = {
        protocol: 'nexio.schedule', version: 3, action: 'replace',
        sentAt: Date.now(), week: phoneWeek(today), days: []
      }
      for (let offset = -14; offset <= 14; offset++) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
        dated.days.push({
          date: dateStrOf(d),
          week: phoneWeek(d),
          isHoliday: false,
          isWorkSwap: false,
          courses: coursesOn(d).map(courseJson)
        })
      }
      /** 手机 WatchPayload.buildWeekJson：只含「导出那一刻的当前教学周」，手表键 0=周日..6=周六 */
      const weekMap = {}
      for (let i = 0; i <= 6; i++) weekMap[String(i)] = []
      for (const c of PHONE_COURSES) {
        if (!active(c, phoneWeek(today))) continue
        weekMap[String(c.dayOfWeek === 7 ? 0 : c.dayOfWeek)].push(courseJson(c))
      }
      return {
        tag,
        dated,
        bucket: {
          protocol: 'nexio.schedule', version: 1, action: 'replace',
          sentAt: Date.now(), scheduleName: '默认课表', holidays: [], week: weekMap
        },
        thisMondayStr: dateStrOf(thisMonday),
        nextMondayStr: dateStrOf(nextMonday),
        wantThis: coursesOn(thisMonday).map((c) => c.name),
        wantNext: coursesOn(nextMonday).map((c) => c.name)
      }
    }

    for (const c of [phoneCase(3, '本周=第4周(双周)'), phoneCase(2, '本周=第3周(单周)')]) {
      console.log(`  --- ${c.tag}：本周一应有 [${c.wantThis.join(',')}]，下周一应有 [${c.wantNext.join(',')}] ---`)
      // 防止 fixture 写错导致「空对空」的假通过
      check(`${c.tag}｜fixture 本周/下周都有课`,
        c.wantThis.length > 0 && c.wantNext.length > 0,
        `本周=[${c.wantThis.join(',')}] 下周=[${c.wantNext.join(',')}]`)

      // 7.x.1 只推按日期直推包（App 启动 / 手环 request 的正常路径）
      const datedOnly = await loadProject(p.src)
      datedOnly.sync.handlePhoneMessage(c.dated)
      check(`${c.tag}｜按日期直推：本周正确`,
        namesOf(datedOnly, c.thisMondayStr).join(',') === c.wantThis.join(','),
        `本周一=[${namesOf(datedOnly, c.thisMondayStr).join(',')}]`)
      check(`${c.tag}｜按日期直推：下周一正确`,
        namesOf(datedOnly, c.nextMondayStr).join(',') === c.wantNext.join(','),
        `下周一=[${namesOf(datedOnly, c.nextMondayStr).join(',')}]`)

      // 7.x.2 先按日期直推、再收到「导出到手环」的整周分桶包
      globalThis.__store = {}
      globalThis.__sent = []
      const both = await loadProject(p.src)
      both.sync.init()
      both.sync.handlePhoneMessage(c.dated)
      both.sync.handlePhoneMessage(c.bucket)
      check(`${c.tag}｜导出到手环之后：本周仍正确`,
        namesOf(both, c.thisMondayStr).join(',') === c.wantThis.join(','),
        `本周一=[${namesOf(both, c.thisMondayStr).join(',')}]`)
      check(`${c.tag}｜导出到手环之后：下周一不被本周快照顶掉`,
        namesOf(both, c.nextMondayStr).join(',') === c.wantNext.join(','),
        `下周一=[${namesOf(both, c.nextMondayStr).join(',')}] 期望=[${c.wantNext.join(',')}]`)
      check(`${c.tag}｜已有按日期数据时不再重复请求（不刷通道）`,
        !globalThis.__sent.some((s) => s && s.action === 'request'),
        `已发送=${JSON.stringify(globalThis.__sent)}`)

      // 7.x.3 导出到手环之后冷启动（手机不在身边）：缓存里必须是按日期数据
      const cold = await loadProject(p.src)
      cold.sync.init()
      await new Promise((r) => setTimeout(r, 30))
      check(`${c.tag}｜冷启动后下周一仍正确`,
        namesOf(cold, c.nextMondayStr).join(',') === c.wantNext.join(','),
        `下周一=[${namesOf(cold, c.nextMondayStr).join(',')}] 缓存=${cold.sync.getStatus().lastShape}`)
      check(`${c.tag}｜冷启动后 hasDates=true（关于页诊断据此显示）`,
        cold.sync.getStatus().hasDates === true, `hasDates=${cold.sync.getStatus().hasDates}`)
    }

    // 7.4 轮询模式：只有整周快照（v2 用户）时，ensureFresh 立即请求按日期数据补齐
    globalThis.__store = {}
    globalThis.__sent = []
    const onlyBucket = await loadProject(p.src)
    onlyBucket.sync.init()
    onlyBucket.sync.handlePhoneMessage(phoneCase(3, 'bucket-only').bucket)
    onlyBucket.sync.ensureFresh('show')
    check('只有整周快照时 hasDates=false，且立即请求按日期数据',
      onlyBucket.sync.getStatus().hasDates === false &&
        globalThis.__sent.some((s) => s && s.action === 'request'),
      `hasDates=${onlyBucket.sync.getStatus().hasDates} 已发送=${JSON.stringify(globalThis.__sent)}`)
  }

  // ---- 7.5 周快照归档：历史周不再被新快照顶掉（「手环只有一周课表」的根因） ----
  {
    const weekA = [{ name: '第41周课', startTime: '08:00', endTime: '09:40', periods: '第1-2节', location: 'A101', teacher: '张老师' }]
    const weekB = [{ name: '第42周课', startTime: '10:00', endTime: '11:40', periods: '第3-4节', location: 'B202', teacher: '李老师' }]
    const bucketFor = (mondayIso, courses, extra) =>
      Object.assign(
        {
          protocol: 'nexio.schedule', version: 2, action: 'replace',
          // 手机推的就是它当前的教学周 → 用推送时间（该周周一）定位归档
          sentAt: localDate(mondayIso).getTime() + 12 * 3600000,
          week: { 1: courses }
        },
        extra || {}
      )
    const arc = await loadProject(p.src)
    arc.sync.handlePhoneMessage(bucketFor('2026-10-05', weekA))
    arc.sync.handlePhoneMessage(bucketFor('2026-10-12', weekB))
    check('周归档：第二周推送后第一周的课仍可查',
      courseNames(view(arc.schedule, arc.util, '2026-10-05')).join(',') === '第41周课' &&
        courseNames(view(arc.schedule, arc.util, '2026-10-12')).join(',') === '第42周课',
      `41周=[${courseNames(view(arc.schedule, arc.util, '2026-10-05')).join(',')}] 42周=[${courseNames(view(arc.schedule, arc.util, '2026-10-12')).join(',')}]`)
    check('周归档：两次推送归档了两周（同周重推覆盖）',
      arc.schedule.archiveCount() === 2,
      `归档 ${arc.schedule.archiveCount()} 周`)
    // 归档随缓存恢复
    globalThis.__store = {}
    const hotArc = await loadProject(p.src)
    hotArc.sync.handlePhoneMessage(bucketFor('2026-10-05', weekA))
    hotArc.sync.handlePhoneMessage(bucketFor('2026-10-12', weekB))
    const coldArc = await loadProject(p.src)
    coldArc.sync.init()
    await new Promise((r) => setTimeout(r, 30))
    check('周归档：冷启动后历史周仍在',
      courseNames(view(coldArc.schedule, coldArc.util, '2026-10-05')).join(',') === '第41周课',
      `41周=[${courseNames(view(coldArc.schedule, coldArc.util, '2026-10-06')).join(',')}] 归档=${coldArc.schedule.archiveCount()}`)
    // 手机发「清空」时归档一并清掉
    const clr = await loadProject(p.src)
    clr.sync.handlePhoneMessage(bucketFor('2026-10-05', weekA))
    clr.sync.handlePhoneMessage({ protocol: 'nexio.schedule', version: 2, action: 'clear' })
    check('clear 动作连带清空周归档', clr.schedule.archiveCount() === 0, `归档 ${clr.schedule.archiveCount()} 周`)
  }

  // ---- 7.6 按日期数据合并：新窗口不清掉旧窗口（覆盖面随使用累积） ----
  {
    const day = (date, week, names) => ({
      date, week, isHoliday: false, isWorkSwap: false,
      courses: names.map((n, i) => ({ id: 'd' + i, name: n, startTime: '08:00', endTime: '09:40', period: 'morning', periods: '第1-2节', location: 'A101', teacher: '张老师' }))
    })
    const datedFor = (days) => ({ protocol: 'nexio.schedule', version: 3, action: 'replace', week: 4, days })
    const win1 = await loadProject(p.src)
    win1.sync.handlePhoneMessage(datedFor([day('2026-10-05', 4, ['十月五日课'])]))
    win1.sync.handlePhoneMessage(datedFor([day('2026-10-20', 6, ['十月二十日课'])]))
    check('按日期合并：新窗口推送后旧日期仍可查',
      courseNames(view(win1.schedule, win1.util, '2026-10-05')).join(',') === '十月五日课' &&
        courseNames(view(win1.schedule, win1.util, '2026-10-20')).join(',') === '十月二十日课',
      `10-05=[${courseNames(view(win1.schedule, win1.util, '2026-10-05')).join(',')}] 10-20=[${courseNames(view(win1.schedule, win1.util, '2026-10-20')).join(',')}]`)
    // 同日期重推以新数据为准
    win1.sync.handlePhoneMessage(datedFor([day('2026-10-05', 4, ['更新后的课'])]))
    check('按日期合并：同日期重推覆盖为新数据',
      courseNames(view(win1.schedule, win1.util, '2026-10-05')).join(',') === '更新后的课',
      `10-05=[${courseNames(view(win1.schedule, win1.util, '2026-10-05')).join(',')}]`)
    // 合并结果随缓存恢复
    globalThis.__store = {}
    const hotMerge = await loadProject(p.src)
    hotMerge.sync.handlePhoneMessage(datedFor([day('2026-10-05', 4, ['十月五日课'])]))
    hotMerge.sync.handlePhoneMessage(datedFor([day('2026-10-20', 6, ['十月二十日课'])]))
    const coldMerge = await loadProject(p.src)
    coldMerge.sync.init()
    await new Promise((r) => setTimeout(r, 30))
    check('按日期合并：冷启动后两个窗口都在',
      courseNames(view(coldMerge.schedule, coldMerge.util, '2026-10-05')).join(',') === '十月五日课' &&
        courseNames(view(coldMerge.schedule, coldMerge.util, '2026-10-20')).join(',') === '十月二十日课',
      `10-05=[${courseNames(view(coldMerge.schedule, coldMerge.util, '2026-10-05')).join(',')}] 10-20=[${courseNames(view(coldMerge.schedule, coldMerge.util, '2026-10-20')).join(',')}]`)
  }

  // ---- 7.7 单双周推断：≥2 个不同周的观测后，未覆盖周按奇偶规律补全 ----
  // （修复「该显示双周课的日子显示单周课」：快照周的奇偶被套到所有日期上）
  {
    const c7 = (id, name) => ({ id, name, startTime: '08:00', endTime: '09:40', periods: '第1-2节', location: 'A101', teacher: '张老师' })
    const bucket7 = (mondayIso, day1) => ({
      protocol: 'nexio.schedule', version: 2, action: 'replace',
      sentAt: localDate(mondayIso).getTime() + 12 * 3600000,
      week: { 1: day1 }
    })
    // 第0周(10-05)推送：全周课+双周课；第1周(10-12)推送：全周课+单周课
    const inf = await loadProject(p.src)
    inf.sync.handlePhoneMessage(bucket7('2026-10-05', [c7('all', '全周课'), c7('even', '双周课')]))
    inf.sync.handlePhoneMessage(bucket7('2026-10-12', [c7('all', '全周课'), c7('odd', '单周课')]))
    check('单双周推断：第2周(未推送)补全双周课、单周课不出现',
      courseNames(view(inf.schedule, inf.util, '2026-10-19')).join(',') === '全周课,双周课',
      `第2周=[${courseNames(view(inf.schedule, inf.util, '2026-10-19')).join(',')}]`)
    check('单双周推断：第3周补全单周课、双周课不出现',
      courseNames(view(inf.schedule, inf.util, '2026-10-26')).join(',') === '全周课,单周课',
      `第3周=[${courseNames(view(inf.schedule, inf.util, '2026-10-26')).join(',')}]`)
    check('单双周推断：观测周本身不变',
      courseNames(view(inf.schedule, inf.util, '2026-10-05')).join(',') === '全周课,双周课' &&
        courseNames(view(inf.schedule, inf.util, '2026-10-12')).join(',') === '全周课,单周课')
    // 超出观测范围 ±2 周：不推断，回退快照（宁可保守也不凭空造课）
    check('单双周推断：超出观测±2周不推断',
      courseNames(view(inf.schedule, inf.util, '2026-11-16')).join(',') === '全周课,单周课',
      `远周=[${courseNames(view(inf.schedule, inf.util, '2026-11-16')).join(',')}]`)
    // 只有一次推送时无法推断：维持快照行为
    const single7 = await loadProject(p.src)
    single7.sync.handlePhoneMessage(bucket7('2026-10-05', [c7('all', '全周课'), c7('even', '双周课')]))
    check('单双周推断：只有一次推送时维持快照内容',
      courseNames(view(single7.schedule, single7.util, '2026-10-12')).join(',') === '全周课,双周课',
      `下周=[${courseNames(view(single7.schedule, single7.util, '2026-10-12')).join(',')}]`)
    // 推断随缓存恢复仍然成立（归档走缓存恢复链路）
    globalThis.__store = {}
    const hotInf = await loadProject(p.src)
    hotInf.sync.handlePhoneMessage(bucket7('2026-10-05', [c7('all', '全周课'), c7('even', '双周课')]))
    hotInf.sync.handlePhoneMessage(bucket7('2026-10-12', [c7('all', '全周课'), c7('odd', '单周课')]))
    const coldInf = await loadProject(p.src)
    coldInf.sync.init()
    await new Promise((r) => setTimeout(r, 30))
    check('单双周推断：冷启动后推断仍然成立',
      courseNames(view(coldInf.schedule, coldInf.util, '2026-10-19')).join(',') === '全周课,双周课',
      `第2周=[${courseNames(view(coldInf.schedule, coldInf.util, '2026-10-19')).join(',')}] 归档=${coldInf.schedule.archiveCount()}`)
  }

  // ---- 7.8 过期按日期数据遮蔽整表：收到 v4 整表后必须清除 ----
  // （真实反馈：旧 APK 推的 ±14 天按日期窗口里，10/10 是调休配置前的旧解析（空），
  //   新 APK 的 v4 整表虽然能算对，但按日期条目优先级更高，把空数据永久顶在最上面）
  {
    const stale = await loadProject(p.src)
    stale.sync.handlePhoneMessage({
      protocol: 'nexio.schedule', version: 3, action: 'replace', week: 4,
      days: [
        { date: '2026-10-10', week: 5, isHoliday: false, isWorkSwap: false, courses: [] }
      ]
    })
    check('7.8 前置：10/10 被过期按日期条目占据（无课）',
      courseNames(view(stale.schedule, stale.util, '2026-10-10')).join(',') === '',
      `10/10=[${courseNames(view(stale.schedule, stale.util, '2026-10-10')).join(',')}]`)
    const pFix = payloadFull()
    pFix.holidays = [
      { date: '2026-10-10', endDate: '', name: '国庆节补班', type: 1, followWeek: 5, followWeekday: 3, custom: true }
    ]
    const rFix = stale.sync.handlePhoneMessage(pFix)
    check('7.8 收到 v4 整表后清除过期条目 → 10/10 补班课显示',
      rFix.ok && courseNames(view(stale.schedule, stale.util, '2026-10-10')).join(',') === '晚自习课',
      `10/10=[${courseNames(view(stale.schedule, stale.util, '2026-10-10')).join(',')}]`)
  }
}

fs.rmSync(WORKROOT, { recursive: true, force: true })

// ---------------------------------------------------------------- 真实课表（可选）
if (REAL && fs.existsSync(REAL)) {
  console.log('\n===== 真实课表（手机导出的课表 JSON）=====')
  const real = JSON.parse(fs.readFileSync(REAL, 'utf8'))
  for (const p of PROJECTS) {
    globalThis.__store = {}
    const inst = await loadProject(p.src)
    const r = inst.sync.handlePhoneMessage(real)
    check(`${p.tag}: 接受真实课表`, r.ok, r.ok ? r.shape : r.error)
    const flat = (dateStr) => view(inst.schedule, inst.util, dateStr).groups.reduce((a, g) => a.concat(g.courses), [])
    // 周次标注：手机给了 current_week 就核对 activeWeek 与之一致
    const wantWeek = Number(real.settings && (real.settings.current_week != null ? real.settings.current_week : real.settings.teachingWeek)) || 0
    if (wantWeek > 0) {
      check(`${p.tag}: activeWeek 与手机 current_week=${wantWeek} 一致`, inst.schedule.activeWeek() === wantWeek, '实际第' + inst.schedule.activeWeek() + '周')
    }
    // 周次按日期推算（与手机端 calendarWeekForDate 一致）：只在真实数据里
    // 存在「中国民俗文化」这门第13周限定的课时才做该项抽查
    const hasMinsu = (real.courses || []).some((c) => c.name === '中国民俗文化')
    if (hasMinsu) {
      // 只断言「第13周(12-01)出现」；该课若另有覆盖第4周的分段（如 w2-12 + selectedWeeks），
      // 第4周出现是正确行为，不做排除断言（数据相关，避免误报）
      const has13 = flat('2026-12-01').some((c) => c.name === '中国民俗文化' && c.timeText === '19:30 - 20:30')
      check(`${p.tag}: 第13周限定的自定义时间课在第13周(12-01)出现`, has13, `w13出现=${has13}`)
    }
    const flatOf = (inst, dateStr) =>
      view(inst.schedule, inst.util, dateStr).groups.reduce((a, g) => a.concat(g.courses), [])
    const printDays = (inst, tag, days) => {
      for (const [d, label] of days) {
        const vm = view(inst.schedule, inst.util, d)
        const list = flatOf(inst, d).map((c) => `${c.name}(${c.timeText} ${c.section}${c.periods ? ' ' + c.periods : ''})`)
        console.log(`  ${tag} ${label} ${d} ${vm.weekText}: ${list.join('  ') || '无课'}`)
      }
    }
    printDays(inst, p.tag, [['2026-09-28', '周一'], ['2026-09-29', '周二'], ['2026-09-30', '周三'], ['2026-10-01', '周四'], ['2026-10-02', '周五']])
    printDays(inst, p.tag, [['2026-10-05', '周一'], ['2026-10-06', '周二'], ['2026-10-07', '周三'], ['2026-10-08', '周四'], ['2026-10-09', '周五'], ['2026-10-10', '周六'], ['2026-10-11', '周日']])

    // 手机端还带假期/调休（截图里 10/07 是「假」、10/10 是「调」补周三课）：
    // payload 里一并下发 holidays，手表才会给出和手机一致的周视图。
    // 这组对照用例依赖当时截图里的具体课程名（工匠精神/单片机），
    // 换了真实数据后只做「可解析 + 可渲染」检查，不硬编码课程名。
    const withHolidays = Object.assign({}, real, {
      holidays: [
        { date: '2026-10-07', endDate: '', name: '调休放假', type: 0, followWeek: -1, followWeekday: -1, custom: false },
        { date: '2026-10-10', endDate: '', name: '补班', type: 1, followWeek: 5, followWeekday: 3, custom: false }
      ]
    })
    const inst2 = await loadProject(p.src)
    const r2 = inst2.sync.handlePhoneMessage(withHolidays)
    const wed = flatOf(inst2, '2026-10-07')
    check(`${p.tag}: 带 holidays 后 10/07 假期隐藏`,
      r2.ok && wed.length === 0 && inst2.schedule.isHolidayDate(new Date(2026, 9, 7)),
      `周三=[${wed.map((c) => c.name).join(',')}]`)
    const sat = flatOf(inst2, '2026-10-10')
    check(`${p.tag}: 10/10 补班按 followWeekday=3 映射到周三的课`,
      r2.ok && sat.length > 0 &&
        sat.every((s) => (real.courses || []).some((c) => c.dayOfWeek === 3 && c.name === s.name)),
      `周六=[${sat.map((c) => c.name).join(',')}]`)
  }
} else {
  console.log('\n(未找到真实课表文件，跳过真实数据检查)')
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
