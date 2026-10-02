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
function payloadFull() {
  return {
    schedule_name: '测试课表',
    settings: {
      class_start_time: '2026/09/13',
      current_week: 4,
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
 * 整表模式：周次**只认手机给的值**（不再按日期自算），
 * 因此所有日期都用 payload 里的 current_week=4；
 * 调休日按手机给的 followWeek（fixture 里是 5）。
 */
const FULL_CASES = [
  { date: '2026-09-14', week: 4, names: ['高等数学'], section: ['morning'] },
  { date: '2026-09-21', week: 4, names: ['高等数学'], section: ['morning'], note: '第4周 单周物理不生效' },
  { date: '2026-09-15', week: 4, names: ['双周化学', '选修课'], section: ['morning', 'afternoon'] },
  { date: '2026-09-29', week: 4, names: ['双周化学', '选修课'], section: ['morning', 'afternoon'] },
  { date: '2026-10-07', week: 4, names: ['晚自习课'], section: ['evening'] },
  { date: '2026-10-08', week: 4, names: ['体育'], section: ['afternoon'] },
  { date: '2026-10-10', week: 5, names: ['高等数学', '单周物理'], section: ['morning', 'morning'], note: '周六补班→周一课(手机给 followWeek=5)' },
  { date: '2026-10-11', week: 4, names: [], section: [] }
]
const FULL_WEEKS = [4]

const localDate = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const STUB_INTERCONNECT = `export default {
  instance() {
    return {
      send() {},
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

let dirSeq = 0
async function loadProject(src) {
  const dir = path.join(WORKROOT, 'w' + dirSeq++)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  fs.writeFileSync(path.join(dir, '__stub-interconnect.js'), STUB_INTERCONNECT)
  fs.writeFileSync(path.join(dir, '__stub-storage.js'), STUB_STORAGE)
  const rewrite = (js) => js
    .replace(/from '@system\.interconnect'/g, "from './__stub-interconnect.js'")
    .replace(/from '@system\.storage'/g, "from './__stub-storage.js'")
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
  check('周次采用手机给的值（current_week=4，不再按日期自算）',
    full.schedule.activeWeek() === 4, '实际 ' + full.schedule.activeWeek())
  for (const c of FULL_CASES) {
    const vm = view(full.schedule, full.util, c.date)
    const got = courseNames(vm)
    const secs = vm.groups.reduce((a, g) => a.concat(g.courses.map((x) => x.section)), [])
    check(`${c.date} 第${c.week}周${c.note ? ' ' + c.note : ''}`,
      got.join(',') === c.names.join(',') && secs.join(',') === c.section.join(','),
      `课程=[${got.join(', ')}] 时段=[${secs.join(', ')}] ${vm.weekText}`)
  }
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
    courseNames(coldVm).join(',') === '双周化学,选修课' && coldFull.schedule.activeWeek() === 4,
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

  // 周次范围缺失（v2 可能不带 startWeek/endWeek）时不能把整门课判没
  const vE = await loadProject(p.src)
  const pE = payloadFull()
  pE.courses = [
    { name: '无周次课', classroom: 'X', teacher: 'Y', dayOfWeek: 1, startSection: 1, endSection: 2, weekType: 0 }
  ]
  vE.sync.handlePhoneMessage(pE)
  const eMon = courseNames(view(vE.schedule, vE.util, '2026-10-12')).join(',')
  check('周次范围缺失的课仍然显示', eMon === '无周次课', `周一=[${eMon}]`)

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
    const w = inst.schedule.activeWeek()
    check(`${p.tag}: 周次用手机给的 current_week=4`, w === 4, '实际第' + w + '周')
    const flat = (dateStr) => view(inst.schedule, inst.util, dateStr).groups.reduce((a, g) => a.concat(g.courses), [])
    // 手机说的是第 4 周 → 只在第13周出现的自定义时间课（19:30 - 20:30）不该出现
    const has13 = flat('2026-12-01').some((c) => c.name === '中国民俗文化' && c.timeText === '19:30 - 20:30')
    const has4 = flat('2026-09-29').some((c) => c.name === '中国民俗文化')
    check(`${p.tag}: 手机给第4周 → 第13周的课不出现、第4周的正常出现`, !has13 && has4, `w13出现=${has13} w4出现=${has4}`)
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
    // payload 里一并下发 holidays，手表才会给出和手机一致的周视图
    const withHolidays = Object.assign({}, real, {
      holidays: [
        { date: '2026-10-07', endDate: '', name: '调休放假', type: 0, followWeek: -1, followWeekday: -1, custom: false },
        { date: '2026-10-10', endDate: '', name: '补班', type: 1, followWeek: 5, followWeekday: 3, custom: false }
      ]
    })
    const inst2 = await loadProject(p.src)
    const r2 = inst2.sync.handlePhoneMessage(withHolidays)
    const wed = flatOf(inst2, '2026-10-07')
    const sat = flatOf(inst2, '2026-10-10')
    check(`${p.tag}: 带 holidays 后 10/07 假期隐藏、10/10 补班上周三课`,
      r2.ok && wed.length === 0 && sat.some((c) => c.name === '工匠精神的实践与养成'),
      `周三=[${wed.map((c) => c.name).join(',')}] 周六=[${sat.map((c) => c.name + ' ' + c.timeText).join(',')}]`)

    // 对照：手机端「旧快照格式」= 只推当前教学周过滤后的周表。
    // 用第 4 周过滤一份快照推给手表（模拟旧手机端），手表在 10/10 会补班映射到周三，
    // 于是把第 4 周周三晚上的「单片机原理及应用B」也显示出来 —— 这就是"对不上"的来源。
    const weekOf = (c, w) =>
      (c.selectedWeeks && c.selectedWeeks.length)
        ? c.selectedWeeks.indexOf(w) >= 0
        : (w >= c.startWeek && w <= c.endWeek && (c.weekType === 1 ? w % 2 === 1 : c.weekType === 2 ? w % 2 === 0 : true))
    const snapshotWeek4 = { protocol: 'nexio.schedule', version: 1, action: 'replace', holidays: withHolidays.holidays, week: {} }
    for (let d = 0; d <= 6; d++) snapshotWeek4.week[String(d)] = []
    for (const c of real.courses) {
      if (!weekOf(c, 4)) continue
      const day = c.dayOfWeek === 7 ? 0 : c.dayOfWeek
      const sec = real.times
      snapshotWeek4.week[String(day)].push({
        name: c.name,
        startTime: c.isCustomTime ? c.customStartTime : (c.startSection <= 6 ? real.times.morning[String(c.startSection)] : c.startSection <= 11 ? real.times.afternoon[String(c.startSection - 6)] : real.times.evening[String(c.startSection - 11)]).split('-')[0],
        endTime: c.isCustomTime ? c.customEndTime : (c.endSection <= 6 ? real.times.morning[String(c.endSection)] : c.endSection <= 11 ? real.times.afternoon[String(c.endSection - 6)] : real.times.evening[String(c.endSection - 11)]).split('-')[1],
        periods: '',
        location: c.classroom,
        teacher: c.teacher
      })
    }
    const inst3 = await loadProject(p.src)
    const r3 = inst3.sync.handlePhoneMessage(snapshotWeek4)
    const sat3 = flatOf(inst3, '2026-10-10')
    check(`${p.tag}: 旧快照格式（第4周）在 10/10 会多出单片机原理及应用B`,
      r3.ok && sat3.length === 2 && sat3.some((c) => c.name === '单片机原理及应用B'),
      `周六=[${sat3.map((c) => c.name).join(',')}]`)
  }
} else {
  console.log('\n(未找到真实课表文件，跳过真实数据检查)')
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
