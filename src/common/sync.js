/**
 * 手机端 → 手表端 同步接口层（协议 nexio.schedule 整表，唯一支持的形态）
 *
 * 对端应用：手机端课程表（包名 com.haooz.chedule，组包见其 wearable/WatchPayload.kt）
 * 主通道：@system.interconnect（小米穿戴 MessageApi ↔ 手表 @system.interconnect）
 * 本地缓存：@system.storage —— 冷启动 / 断开手机后仍可查看上次同步的课表
 *
 * ---------------------------------------------------------------------------
 * 协议（以手机端 WatchPayload.buildFullJson 为准）
 * ---------------------------------------------------------------------------
 * {
 *   "protocol": "nexio.schedule",
 *   "version": 4.1,                     // 手机端 WatchPayload.VERSION；手环对 4.x 一律宽容
 *   "action": "replace",                 // replace=整表覆盖 | clear=清空
 *   "sentAt": 1760000000000,             // 手机组包时刻（周次校准基准，见 applyPayload）
 *   "schedule_name": "默认课表",
 *   "settings": {
 *     "class_start_time": "2026/09/13",  // 开学日（手环据此推算任意日期的教学周）
 *     "current_week": 4,                 // 推送时刻的教学周（校准调休合并周偏移）
 *     "total_weeks": 18,
 *     "morning_sections": 6, "afternoon_sections": 5, "evening_sections": 3
 *   },
 *   "times": { "morning": {"1":"08:00-08:40", ...}, "afternoon": {...}, "evening": {...} },
 *   "courses": [
 *     { "id":"c1", "name":"高等数学", "dayOfWeek":1, "startSection":1, "endSection":2,
 *       "startWeek":2, "endWeek":12, "weekType":0, "selectedWeeks":[],
 *       "isCustomTime":false, "customStartTime":"", "customEndTime":"",
 *       "location":"A101", "teacher":"张老师" }
 *   ],
 *   "holidays": [
 *     { "date":"2026-10-01", "endDate":"2026-10-07", "name":"国庆节", "type":0,
 *       "followDate":"", "followWeek":-1, "followWeekday":-1, "custom":false },
 *     { "date":"2026-10-10", "endDate":"", "name":"补班", "type":1,
 *       "followDate":"2026-10-12", "followWeek":6, "followWeekday":1, "custom":false }
 *   ],
 *   "overrides": [                        // v4.1：手机逐日裁决好的答案（可缺省）
 *     { "date":"2026-10-01", "weekday":4, "week":4, "holiday":true,
 *       "workswap":false, "holidayName":"国庆节", "courses":[] }
 *   ]
 * }
 *
 * 字段语义：
 *   - dayOfWeek 1=周一 .. 7=周日（手机域）；手环内部 0=周日 .. 6=周六，
 *     换算在 schedule.normalizeFullCourse 里完成。
 *   - weekType 0=全周 1=单周 2=双周；selectedWeeks 非空时优先于
 *     startWeek/endWeek/weekType（与手机端 Course.isActiveInWeek 严格一致）。
 *   - holidays[].type 0=假期（隐藏当天课程）1=调休（改上 followDate 那天的课）。
 *     调休优先用 followDate（绝对日期，手机端唯一可信来源，换课表不跟错）；
 *     它缺失时才回退老的 followWeek/followWeekday（迁移期兼容）。
 *   - overrides[] 是手机对调休日 / 假期端点日的最终裁决，命中即整日采用，
 *     未命中才回退下面的自行推算（见 schedule.setDayOverrides）。
 *
 * 手环侧自行推算学期内任意一天的教学周，公式与手机端
 * CourseScheduleDateBounds.calendarWeekForDate 一致（周一起算，第 1 周 = 开学日
 * 所在周的周一），并用推送时刻的 current_week 校准调休合并周造成的偏移，
 * 因此手环与手机「第几周」永远一致，翻到任何日期都有完整课表。
 *
 * 兼容性：旧协议的按周分桶（v1/v2）、按日期直推（v3）路径已全部移除。
 * 收到没有 courses 数组的包会明确拒绝，不再降级解析 —— 请与新版 APK 一起上线。
 * version 只做诊断：手机发 4.1（多了 overrides），手环按整表结构解析，不因版本号拒包。
 *
 * 手机端主动要数据（手动接口；手机端 WearableScheduleSync 收到 action=request
 * 就整包推送，它只校验 protocol / action）：
 * { "protocol": "nexio.schedule", "version": 4, "action": "request", "reason": "manual" }
 *
 * 反方向：对端要手环手上的数据（AstroBox 插件「从手环获取课表」）。
 * 对端发 { "protocol": "nexio.schedule", "version": 4, "action": "export" }，
 * 手环把本地缓存的整表回传：
 *   { protocol, version, action:"export", ok:true, sentAt, savedAt,
 *     payload: <手机协议形态的 v4 整表> }
 * 手环里没有课表时回 ok:false, error:"no_schedule"（不让对端干等超时）。
 * 导出走本地缓存，所以手机不在身边、通道只连 AstroBox 时也能取到课表。
 * 注意 request 与 export 方向相反：request = 手环要手机的数据，
 * export = 对端要手环的数据。
 *
 * 读取频率：手机端点「推送到手环」是主要数据入口；另外启动 / onShow（数据过期）/
 * 通道重连 / 定时轮询会发一次 request 兜底自愈。
 *
 * 传输失败（手机推来的包用不了，或 request 后手机一直没回应）时会上报
 * 一次「传输出错」，页面通过 onXferError 订阅、dismissXferError 收起，
 * 详情见文件后半段的「传输失败页」一节。
 *
 * 注意：interconnect 要求手表 rpk 与手机 App **包名、签名都一致**；
 * 任何一项不符都会连不上（表现为 send 一直失败 / 收不到推送），
 * 具体原因靠 connect.diagnosis 区分（见 diagHint）。
 */

import interconnect from '@system.interconnect'
import storage from '@system.storage'
import prompt from '@system.prompt'
import schedule from './schedule'

const PROTOCOL = 'nexio.schedule'
/** 向手机端发请求时带的协议版本 */
const PROTOCOL_VERSION = 4
/** 本地缓存的内部版本号（缓存由本模块写入，格式自保证） */
const CACHE_VERSION = 0
/**
 * 存储键升过一次代（v1 → v2）：内置调试课表删除前是走真实同步链路注入的，
 * 会被 persist() 写进 storage；只删代码不清缓存的话，冷启动仍会把旧课表恢复
 * 出来。换键让旧缓存永久孤儿化，一次解决所有设备。
 */
const STORAGE_KEY = 'nexio.schedule.payload.v2'

const ACTION = {
  REPLACE: 'replace',
  CLEAR: 'clear',
  REQUEST: 'request',
  /**
   * 导出：对端（AstroBox 插件「从手环获取课表」）要手环里缓存的整表。
   * 收：{ protocol, action:'export', reason, sentAt }
   * 回：{ protocol, action:'export', ok, error?, payload?: <v4 整表> }
   * 与 request 相反方向 —— request 是手环要数据，export 是对端要手环的数据。
   */
  EXPORT: 'export'
}

/** 手机端包名（interconnect 对端；两端 package 必须一致） */
const PEER_PACKAGE = 'com.haooz.chedule'

const listeners = []
let connect = null
let ready = false
let lastError = null
let cachedQuote = ''
/**
 * 最近一次「已应用」的整表（协议格式，scheduleName 驼峰）。
 * 只用于 action=export 回传：手环自己的渲染走 schedule.js 的状态，
 * 这里额外留一份原件，导出时才能把手机推来的数据原样还回去
 * （含 sentAt —— 周次校准的基准，重算会让教学周/单双周错位）。
 * action=clear 后置空：清空了就没有课表可导出。
 */
let lastPayload = null
/** 已应用的最新同步序号 */
let appliedRev = 0
/** 主动请求同步的最小间隔，避免 onShow/重试把通道刷爆 */
const REQUEST_MIN_GAP_MS = 15000
/** 请求发出后等多久没收到数据就重试；逐次翻倍退避，最多重试几次 */
const RETRY_DELAY_MS = 4000
const MAX_RETRY = 3
/** 本地数据超过这个时间就认为过期，页面 onShow 时主动向手机要一次 */
const STALE_MS = 5 * 60 * 1000
/** 定时轮询间隔：整表包不大，5 分钟一次足以自愈，又不会明显耗电 */
const POLL_INTERVAL_MS = 5 * 60 * 1000
/** 通道诊断最小间隔：断连/失败时不要每次都问一遍系统 */
const DIAG_MIN_GAP_MS = 20000
/**
 * 启动时 getReadyState 未就绪的短轮询。
 * 官方 FAQ 明确说「进入页面直接获取状态往往会拿到 DISCONNECTED，因此需要轮询」，
 * 只信一次会把「其实已经连上、只是状态还没刷新」误判成未连接，
 * 于是既不发请求、也一直挂着「手机未连接」。
 */
const READY_POLL_MAX = 5
const READY_POLL_GAP_MS = 1200

/** 本地缓存时间戳（0 表示当前进程还没有可用缓存） */
let cachedAt = 0
/**
 * 冷启动本地缓存是否还在恢复中：storage.get 是异步的，回调回来前
 * 页面拿不到数据，若此时渲染会误判"没数据"闪一下"请连接手机"空态。
 * init 置 true，storage 回调（success/fail/异常）置 false；
 * 页面据此决定首帧是等通知还是直接渲染。
 */
let cachePending = false
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
/** getReadyState 短轮询句柄 */
let readyPollTimer = null
/** 本次连接是否已弹过「已连接手机」toast（断开后重置，重连才再弹） */
let connectNotified = false
/**
 * 通道诊断结果：connect.diagnosis 的 status
 *   0=正常 204=连接超时 1001=对端 App 未安装 1000=其它 -1=诊断不可用/未诊断
 * 这是「课表推不过来」时唯一能区分「没装手机端」和「通道没通」的依据，
 * 页面把它当连接状态卡的副文案展示（见 index.ux refreshDiagnostics）。
 */
let diagCode = -1
let diagHint = ''
let lastDiagAt = 0

/** 诊断码 → 给用户看的一句话（能在手环上直接照做；长度受状态卡一行 22px 限制） */
const DIAG_HINT = {
  204: '连接超时，检查配对',
  1001: '手机端未安装 Nexio',
  1000: '连接异常，重开 App'
}

function diagHintOf(code) {
  if (code === 0) return ''
  return DIAG_HINT[code] || (code > 0 ? '连接异常（' + code + '）' : '')
}

/**
 * 通道接通时提示一次「已连接手机」；重复触发（onopen 与 getReadyState 都报告就绪）不重复弹。
 *
 * 只走系统 showToast（居中大提示）。页面内原本还有一套底部自绘 toast，
 * 冷启动时 app.ux 的 init 早于页面挂监听，那一刻走系统 toast；页面监听随后又收到一次，
 * 于是「居中大 + 底部小」两个同时出现。双份提示已删除，此处是唯一出口。
 */
function notifyConnected() {
  if (connectNotified) return
  connectNotified = true
  try {
    prompt.showToast({ message: '已连接手机', duration: 2000 })
  } catch (e) {
    console.log('[sync] showToast fail', e)
  }
}

function notify() {
  for (let i = 0; i < listeners.length; i++) {
    try {
      listeners[i]()
    } catch (e) {
      console.log('[sync] listener error', e)
    }
  }
}

/**
 * 诊断与手机端的通道（connect.diagnosis，Vela 官方接口）。
 *
 * 为什么必须有它：send 失败只会给一个笼统的 1006/204，而「手环上压根没装
 * 手机端 App」「签名/包名不一致」「手机端 App 没启动」在手环上的表现完全一样
 * —— 都是收不到数据。diagnosis 能把它们分开：
 *   0    通道正常
 *   204  连接超时（配对/蓝牙链路问题）
 *   1001 对端 App 未安装（包名不对、或手环上没装 Nexio 手机端配套应用）
 *   1000 其它（多半是签名不一致，见文档「签名不正确通信会被拒绝」）
 * 结果写进 diagCode/diagHint，连接状态卡直接展示，用户照着一句话就能处理。
 *
 * @param {boolean} force 忽略间隔限制（只给手动/首次连不上时用）
 */
function diagnose(force) {
  if (!connect || typeof connect.diagnosis !== 'function') {
    // 老固件没有这个接口：不报错，只是没有原因可展示
    diagCode = -1
    diagHint = ''
    return
  }
  const now = Date.now()
  if (!force && now - lastDiagAt < DIAG_MIN_GAP_MS) return
  lastDiagAt = now
  try {
    connect.diagnosis({
      timeout: 3000,
      success: function (data) {
        const code = data && data.status != null ? Number(data.status) : -1
        const changed = code !== diagCode
        diagCode = code
        diagHint = diagHintOf(code)
        console.log('[sync] diagnosis=' + code + ' ' + diagHint)
        // 错误页正亮着：报错那一刻 diagnosis 往往还没回来（异步 + 3s 超时），
        // 结果到了就把它补进日志，让人看到「连接超时，检查配对」这类原因。
        if (xferError) {
          xferError.hint = diagHint
          xferError.lines = buildXferLog(xferError)
          emitXferError()
        }
        // 诊断结果本身就要展示，变了才通知页面重渲染
        if (changed) notify()
      },
      fail: function (data, code) {
        console.log('[sync] diagnosis fail ' + code)
        diagCode = -1
        diagHint = ''
      }
    })
  } catch (e) {
    console.log('[sync] diagnosis error', e)
  }
}

/**
 * 启动时把 getReadyState 多问几次（间隔逐次拉长，总共约 18s）。
 *
 * 只问一次的问题：应用刚起来时系统常报「未连接」，此时既不请求也不轮询，
 * 用户看到的就是一直「手机未连接」—— 即使通道其实马上就绪（真机上很常见）。
 * 一旦某次拿到 status=1 就当作 onopen 处理：提示连接、强制拉一次、开始轮询。
 */
function pollReadyState(attempt) {
  if (ready || !connect) return
  if (attempt >= READY_POLL_MAX) return
  if (readyPollTimer) clearTimeout(readyPollTimer)
  readyPollTimer = setTimeout(function () {
    readyPollTimer = null
    if (ready || !connect) return
    const onNotReady = function () {
      pollReadyState(attempt + 1)
    }
    try {
      connect.getReadyState({
        success: function (data) {
          if (data && data.status === 1) {
            ready = true
            diagCode = 0
            diagHint = ''
            console.log('[sync] ready via poll, attempt=' + (attempt + 1))
            notifyConnected()
            requestSync('ready-poll', true)
            startPolling()
          } else {
            onNotReady()
          }
        },
        fail: onNotReady
      })
    } catch (e) {
      onNotReady()
    }
  }, READY_POLL_GAP_MS * (attempt + 1))
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
/** 上一次 parseMessage 是否因为 JSON 坏掉而返回 null（区分「空包」和「坏 JSON」） */
let parseFailed = false
function parseMessage(raw) {
  if (raw == null) return null
  if (typeof raw === 'string') {
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch (e) {
      lastError = 'invalid json'
      parseFailed = true
      return null
    }
  }
  // interconnect onmessage 回调可能包一层 { data: '...' }，也可能包成 { data: {...} }
  // （对端把整个 send 参数序列化过来的形态，见 AstroBox 插件 1.1.1 的同名修复）
  if (isPlainObject(raw) && raw.protocol == null && raw.data != null) {
    if (typeof raw.data === 'string') return parseMessage(raw.data)
    if (isPlainObject(raw.data)) return parseMessage(raw.data)
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
 * 归一化假期/调休（兼容 HolidayManager.Entry）：
 * [{date|start, endDate|end, name, type, followDate, followWeek, followWeekday}]
 * type: 0=假期(隐藏课程) 1=调休(改上 followDate 那天的课)
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
      /* 调休目标绝对日期（手机端唯一可信来源）；空串表示未配置 */
      followDate: String(item.followDate || ''),
      followWeek: isNaN(week) ? -1 : week,
      followWeekday: isNaN(weekday) ? -1 : weekday
    })
  }
  return out
}

/**
 * 校验并归一化手机端 payload（仅接受 version=4 整表）。
 * 成功返回 { ok: true, payload }；
 * 失败返回 { ok: false, error, code, version } —— code 是给「传输出错」页
 * 直接翻译成人话用的短标签（json / empty / protocol / no-courses），
 * version 是有就带上，方便页面告诉用户「手机端是第几版」。
 */
function normalizePayload(raw) {
  parseFailed = false
  const parsed = parseMessage(raw)
  if (!parsed) {
    return {
      ok: false,
      error: parseFailed ? 'invalid json' : 'empty payload',
      code: parseFailed ? 'json' : 'empty'
    }
  }
  /** 诊断用：手机原始 payload 里出现了哪些已知字段 */
  const KNOWN_FIELDS = [
    'protocol', 'version', 'action', 'courses', 'settings', 'times', 'holidays',
    'current_week', 'class_start_time', 'total_weeks', 'schedule_name'
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

  const version = parsed.version != null ? Number(parsed.version) : 0

  if (parsed.protocol && parsed.protocol !== PROTOCOL) {
    return {
      ok: false,
      error: 'protocol mismatch: ' + parsed.protocol,
      code: 'protocol',
      version: version
    }
  }

  const action = parsed.action || ACTION.REPLACE
  const holidayList = normalizeHolidays(parsed.holidays)

  if (action === ACTION.CLEAR) {
    return {
      ok: true,
      shape: '清空 字段[' + rawFields + ']',
      payload: {
        action: ACTION.CLEAR,
        /* 组包时刻原样保留（0=对端没给），不要在这里用本机时间兜底：
           它要做周次校准的基准，见 applyPayload/weekAtOf。 */
        sentAt: Number(parsed.sentAt) || 0,
        savedAt: parsed.savedAt || 0,
        quote: parsed.quote || '',
        holidays: holidayList
      }
    }
  }

  // 整表是唯一支持的形态：必须有 courses 数组
  if (!Array.isArray(parsed.courses)) {
    return {
      ok: false,
      error:
        'v4 整表 required（无 courses 数组；version=' + (parsed.version != null ? parsed.version : '?') +
        ' 字段[' + rawFields + ']）。旧协议 v1/v2/v3 已不再支持，请升级手机端。',
      code: 'no-courses',
      version: version
    }
  }
  if (version !== PROTOCOL_VERSION && version !== CACHE_VERSION) {
    // 有 courses 但仍提示版本异常：仍按整表解析（结构自描述），只是留个诊断记录。
    // CACHE_VERSION 是本模块写缓存时标记的内部版本，不是异常。
    console.log('[sync] unexpected version ' + version + '，按 v4 整表结构解析')
  }

  const st = isPlainObject(parsed.settings) ? parsed.settings : {}

  return {
    ok: true,
    shape:
      '整表 字段[' +
      rawFields +
      '] 课' +
      parsed.courses.length +
      ' 周' +
      (st.current_week != null ? st.current_week : '?') +
      '/' +
      (st.total_weeks != null ? st.total_weeks : '?') +
      ' 假' +
      holidayList.length,
    payload: {
      action: action,
      /* 手机组包时刻原样透传（0=对端没给），周次校准基准见 weekAtOf */
      sentAt: Number(parsed.sentAt) || 0,
      savedAt: parsed.savedAt || 0,
      quote: parsed.quote || '',
      scheduleName: String(parsed.schedule_name || parsed.scheduleName || ''),
      holidays: holidayList,
      courses: parsed.courses,
      settings: st,
      times: isPlainObject(parsed.times) ? parsed.times : {},
      overrides: Array.isArray(parsed.overrides) ? parsed.overrides : []
    }
  }
}

/** 写缓存：只保留有用字段（storage 的 value 必须是字符串） */
function compactForCache(payload) {
  return {
    protocol: PROTOCOL,
    version: CACHE_VERSION,
    action: payload.action || ACTION.REPLACE,
    /* sentAt 必须入缓存：冷启动恢复时它是唯一能跟 current_week 对齐的时刻，
       丢了就只能拿本机当前时间去校准，缓存放几天后周次会整体错位。 */
    sentAt: payload.sentAt || 0,
    savedAt: payload.savedAt || Date.now(),
    quote: payload.quote || '',
    scheduleName: payload.scheduleName || '',
    holidays: payload.holidays || [],
    courses: payload.courses || [],
    settings: payload.settings || {},
    times: payload.times || {},
    overrides: payload.overrides || []
  }
}

/**
 * 周次校准基准时刻 = 手机组包时刻（sentAt）。
 *
 * current_week 是手机在**它自己的时钟**下算出来的，校准必须用同一个时钟的时刻；
 * 用本机 Date.now() 的话，手环时间只要有偏差（出厂未同步、被手动改过、跨时区），
 * 算出来的 offset 就会多/少一周 —— 单双周跟着翻转，直到手机再推一次才自愈。
 * 老数据/老缓存没有 sentAt，退回入缓存时刻，最后才用当前时间。
 */
function weekAtOf(payload) {
  if (!payload) return Date.now()
  return Number(payload.sentAt) > 0
    ? Number(payload.sentAt)
    : payload.savedAt || Date.now()
}

function persist(payload, done) {
  const value = JSON.stringify(compactForCache(payload))
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
    schedule.clearWeekState()
    schedule.setDayOverrides([])
    schedule.setHolidays([])
    schedule.setQuote(cachedQuote)
    return
  }
  schedule.setFullSchedule({
    courses: payload.courses || [],
    settings: payload.settings || {},
    times: payload.times || {},
    // 周次校准的基准时刻：用手机组包时刻（sentAt），与 current_week 同源。
    // 不能用本机 new Date()，也不能用本机收到的时刻 —— 手环时钟有偏差时
    // 会把 offset 算成 ±1 周，单双周跟着翻转（详见 weekAtOf / calibrateWeekOffset）。
    at: weekAtOf(payload)
  })
  schedule.setHolidays(payload.holidays || [])
  schedule.setDayOverrides(payload.overrides || [])
  schedule.setQuote(cachedQuote)
}

/** 记下当前生效的整表，供 action=export 回传；clear 视为「没有课表」 */
function rememberPayload(payload) {
  lastPayload = payload && payload.action !== ACTION.CLEAR ? payload : null
}

/**
 * 手环内部把 holidays 归一成了 start/end，导出要换回手机协议的 date/endDate，
 * 否则插件/手机端拿到的课表虽然能用，字段名却和原始数据对不上
 * （回推时又会各自归一一次，长期看很容易出隐性差异）。
 */
function holidaysToPhone(list) {
  const out = []
  for (let i = 0; i < list.length; i++) {
    const h = list[i]
    if (!h) continue
    out.push({
      date: h.start || '',
      endDate: h.end || h.start || '',
      name: h.name || '',
      type: h.type === 1 ? 1 : 0,
      followDate: h.followDate || '',
      followWeek: h.followWeek == null ? -1 : h.followWeek,
      followWeekday: h.followWeekday == null ? -1 : h.followWeekday,
      custom: false
    })
  }
  return out
}

/**
 * 组装导出回包：把已应用的整表还原成手机协议（v4 整表）形态。
 * ok=false 时也回一包（error='no_schedule'），让对端立刻知道「手环里没课表」，
 * 而不是等超时再猜。
 */
function buildExportMessage() {
  if (!lastPayload) {
    return {
      protocol: PROTOCOL,
      version: PROTOCOL_VERSION,
      action: ACTION.EXPORT,
      ok: false,
      error: 'no_schedule',
      sentAt: Date.now()
    }
  }
  const p = lastPayload
  return {
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    action: ACTION.EXPORT,
    ok: true,
    /* 回包时刻（本机时钟，仅用于诊断） */
    sentAt: Date.now(),
    savedAt: p.savedAt || 0,
    payload: {
      protocol: PROTOCOL,
      version: PROTOCOL_VERSION,
      action: ACTION.REPLACE,
      /* 原样回传：sentAt 是 current_week 的校准基准，重算会让周次错位。
         老数据没有 sentAt 时按 weekAtOf 的同一口径回退到入缓存时刻 */
      sentAt: p.sentAt || p.savedAt || 0,
      savedAt: p.savedAt || 0,
      schedule_name: p.scheduleName || '',
      settings: p.settings || {},
      times: p.times || {},
      courses: p.courses || [],
      holidays: holidaysToPhone(p.holidays || []),
      overrides: p.overrides || []
    }
  }
}

/* ---------------------------------------------------------------------------
 * 回传浮层状态：对端（AstroBox 插件）发 action=export 时，页面上要盖一层
 * 「正在回传课表」+ 进度条。发送本身是瞬时的，所以进度按时间推进：
 * 收到请求亮起 → 匀速走到 88%（别让用户等一个假的 100%）→ 发送回调成功后
 * 补满 100% → 稍留一会儿再收起，让人看得见。
 * 页面通过 onExportState 订阅，返回 { active, percent }。
 * ------------------------------------------------------------------------- */
const exportListeners = []
let exportActive = false
let exportPercent = 0
let exportTicker = null
let exportHideTimer = null

function emitExportState() {
  const st = { active: exportActive, percent: exportPercent }
  for (let i = 0; i < exportListeners.length; i++) {
    try {
      exportListeners[i](st)
    } catch (e) {
      console.log('[sync] export listener error ' + e)
    }
  }
}

function setExportState(active, percent) {
  exportActive = active
  exportPercent = percent
  emitExportState()
}

/** 收到导出请求：亮起浮层并开始推进 */
function beginExportUi() {
  if (exportHideTimer) {
    clearTimeout(exportHideTimer)
    exportHideTimer = null
  }
  if (exportTicker) {
    clearInterval(exportTicker)
    exportTicker = null
  }
  setExportState(true, 6)
  exportTicker = setInterval(function () {
    if (!exportActive || exportPercent >= 88) {
      clearInterval(exportTicker)
      exportTicker = null
      return
    }
    setExportState(true, Math.min(88, exportPercent + 7))
  }, 58)
}

/** 回包已发出：补满进度再收起（失败时多停一会儿，让人看清没成） */
function endExportUi(ok) {
  if (exportTicker) {
    clearInterval(exportTicker)
    exportTicker = null
  }
  setExportState(true, 100)
  exportHideTimer = setTimeout(function () {
    exportHideTimer = null
    setExportState(false, 0)
  }, ok ? 360 : 900)
}

/** 立即收起（页面销毁 / 通道断开时兜底，别留一层黑屏挡住界面） */
function resetExportUi() {
  if (exportTicker) {
    clearInterval(exportTicker)
    exportTicker = null
  }
  if (exportHideTimer) {
    clearTimeout(exportHideTimer)
    exportHideTimer = null
  }
  if (exportActive) setExportState(false, 0)
}

/**
 * 订阅回传浮层状态，返回取消函数。订阅时会立刻回放一次当前状态，
 * 避免「先亮后订阅」那一下漏掉。
 */
function onExportState(fn) {
  if (typeof fn !== 'function') {
    return function () {}
  }
  exportListeners.push(fn)
  try {
    fn({ active: exportActive, percent: exportPercent })
  } catch (e) {
    console.log('[sync] export listener error ' + e)
  }
  return function () {
    const idx = exportListeners.indexOf(fn)
    if (idx >= 0) exportListeners.splice(idx, 1)
  }
}

/* ---------------------------------------------------------------------------
 * 传输失败页（设计稿「画板 1 副本 5.svg」）：红圈白叉 + 「传输出错」+ 传输日志。
 *
 * 什么时候弹：**确实有一次课表传输失败了**才弹 ——
 *   1. 手机推过来的包手环用不了（坏 JSON / 协议不符 / 没有 courses 数组）；
 *   2. 手环发出 action=request 后，重试用尽手机一直没回应。
 * 不弹的情况：单纯没连上手机（没配对、蓝牙没开、手机端没装）—— 那属于
 * 关于页的连接状态卡，一开机就糊一层错误页反而挡住了本来能看的缓存课表。
 *
 * 日志区按设计稿只有 123px 高（5 行），所以行必须短：哪一步失败 / 为什么 / 怎么办。
 * 用户点一下收起后，**同一类错误不再自动弹**（5 分钟一次的轮询会把同一包坏数据
 * 反复推过来），直到下一次传输成功才解除静音。
 * ------------------------------------------------------------------------- */
const xferErrorListeners = []
/** 日志行上限 = 设计稿日志区 123px / 行高 24px ≈ 5 行 */
const XFER_LOG_MAX = 5
/** 当前要展示的失败信息（null = 不展示）；lines 已是可以直接渲染的短句 */
let xferError = null
/** 被用户点掉的那一类错误（phase|code）：同类不再弹，传输成功才清空 */
let xferErrMuted = ''

/** 'HH:mm' —— 不引 util：sync 只依赖 schedule，日志时间自己拼一下 */
function xferClock() {
  const d = new Date()
  const hh = d.getHours() < 10 ? '0' + d.getHours() : '' + d.getHours()
  const mm = d.getMinutes() < 10 ? '0' + d.getMinutes() : '' + d.getMinutes()
  return hh + ':' + mm
}

/** 失败码 → 一行原因（22px 下一行约 12 个汉字，都得短） */
const XFER_REASON = {
  json: '收到的不是合法 JSON',
  empty: '收到一个空包',
  protocol: '协议标记对不上',
  'no-courses': '缺少 courses 数组',
  request: '手机端一直没有回应'
}

/** 失败码 → 该怎么办（能照做的一句话） */
const XFER_ADVICE = {
  json: '重开 Nexio 再推送一次',
  empty: '重开 Nexio 再推送一次',
  protocol: '两端协议不一致，同步升级',
  'no-courses': '手机端太旧，请升级 Nexio',
  request: '检查蓝牙配对，重开 Nexio'
}

/**
 * 组装日志行。设计稿那块区域只有 5 行高，所以顺序是
 * 「时间+哪一步」→「原因」→「手机端版本」→「通道诊断」→「怎么办」。
 */
function buildXferLog(info) {
  const lines = []
  const head = info && info.phase === ACTION.REQUEST ? '传输超时' : '推送数据异常'
  lines.push(xferClock() + ' ' + head)
  const code = (info && info.code) || ''
  if (XFER_REASON[code]) lines.push(XFER_REASON[code])
  /* 版本只在「拿到了但用不了」时有意义：让用户一眼看出手机端是哪一版 */
  if (info && info.version) lines.push('手机端协议 v' + info.version)
  if (info && info.hint) lines.push(info.hint)
  if (XFER_ADVICE[code]) lines.push(XFER_ADVICE[code])
  return lines.slice(0, XFER_LOG_MAX)
}

/** 给页面的状态快照（emit 与订阅回放必须同一形态，否则「先亮后订阅」会拿到半截数据） */
function xferErrorState() {
  return xferError
    ? { active: true, title: '传输出错', lines: xferError.lines, code: xferError.code, phase: xferError.phase }
    : { active: false, title: '', lines: [], code: '', phase: '' }
}

function emitXferError() {
  const st = xferErrorState()
  for (let i = 0; i < xferErrorListeners.length; i++) {
    try {
      xferErrorListeners[i](st)
    } catch (e) {
      console.log('[sync] xfer error listener error ' + e)
    }
  }
}

/**
 * 报一次传输失败并让页面盖出错误页。
 * @param {{phase:string, code:string, version?:number, hint?:string}} info
 */
function reportXferError(info) {
  const phase = (info && info.phase) || 'push'
  const code = (info && info.code) || ''
  const key = phase + '|' + code
  if (xferErrMuted === key) return
  xferError = {
    key: key,
    phase: phase,
    code: code,
    version: (info && info.version) || 0,
    hint: (info && info.hint) || '',
    lines: buildXferLog({ phase: phase, code: code, version: info && info.version, hint: info && info.hint })
  }
  console.log('[sync] xfer error: ' + xferError.lines.join(' / '))
  emitXferError()
}

/** 用户点掉错误页：收起，并把这一类错误静音（不再自动弹） */
function dismissXferError() {
  if (!xferError) return
  xferErrMuted = xferError.key
  xferError = null
  emitXferError()
}

/** 传输成功（收到可用整表 / 清空指令）：收起错误页并解除静音 */
function resolveXferError() {
  xferErrMuted = ''
  if (!xferError) return
  xferError = null
  emitXferError()
}

/** 订阅传输失败状态，返回取消函数；订阅时先回放当前状态避免漏掉先亮后订阅 */
function onXferError(fn) {
  if (typeof fn !== 'function') {
    return function () {}
  }
  xferErrorListeners.push(fn)
  try {
    fn(xferErrorState())
  } catch (e) {
    console.log('[sync] xfer error listener error ' + e)
  }
  return function () {
    const idx = xferErrorListeners.indexOf(fn)
    if (idx >= 0) xferErrorListeners.splice(idx, 1)
  }
}

/** 把回包发回对端（手机侧：Nexio APK 或 AstroBox 插件） */function sendToPeer(body) {
  if (!connect) return false
  let settled = false
  let failReason = ''
  function settle(ok, note) {
    if (settled) return
    settled = true
    if (note) {
      lastError = note
      console.log('[sync] ' + note)
    }
    endExportUi(ok)
  }
  try {
    connect.send({
      data: body,
      success: function () {
        console.log('[sync] export sent')
        settle(true)
      },
      fail: function (data, code) {
        failReason = 'export send fail ' + code
        settle(false, failReason)
      }
    })
    /* 实机上 success 回调有时不回来，浮层就会永远停在 88%。
       发送本身是同步投递给桥接层的，这里给个兜底：600ms 内没有 fail
       就按发送成功收尾，别把人锁在黑屏上。 */
    setTimeout(function () {
      settle(!failReason, failReason)
    }, 600)
    return true
  } catch (e) {
    lastError = 'export send error ' + e
    console.log('[sync] ' + lastError)
    return false
  }
}

/** 处理 action=export（AstroBox 插件「从手环获取课表」） */
function handleExportRequest() {
  // 先亮浮层：手环屏上要有「正在回传课表」的即时反馈
  beginExportUi()
  const body = buildExportMessage()
  if (!body.ok) {
    lastError = body.error
    console.log('[sync] export rejected: ' + body.error)
  }
  if (!sendToPeer(body)) {
    endExportUi(false)
    return { ok: false, error: lastError || 'export send failed' }
  }
  if (!body.ok) return { ok: false, error: body.error }
  const pc = (body.payload.courses || []).length
  const ph = (body.payload.holidays || []).length
  return { ok: true, shape: '导出整表 课' + pc + ' 假' + ph }
}

/**
 * 手机端消息统一入口（也可被调试工具直接调用）
 * @param {string|object} raw 手机推送
 * @returns {{ok:boolean, error?:string, shape?:string}}
 */
function handlePhoneMessage(raw) {
  // 导出请求不是课表数据，先分流：直接丢给 normalizePayload 会被判成
  // 「v4 整表 required（无 courses 数组）」拒掉，对端就只能干等超时
  const probe = parseMessage(raw)
  if (probe && probe.action === ACTION.EXPORT) {
    return handleExportRequest()
  }
  const result = normalizePayload(raw)
  if (!result.ok) {
    lastError = result.error
    console.log('[sync] reject payload:', result.error)
    // 手机确实把课表推过来了、但手环用不了：这就是「传输课表出错」，
    // 盖上设计稿的错误页，把失败原因和该怎么办摊给用户看
    reportXferError({ phase: 'push', code: result.code, version: result.version, hint: diagHint })
    return result
  }
  appliedRev += 1
  const rev = appliedRev
  /* savedAt 只用于「最后一次本地更新时间」展示（本机时钟）；
     周次校准另走 sentAt，两者不能混用，见 weekAtOf。 */
  result.payload.savedAt = Date.now()
  rememberPayload(result.payload)
  lastSource = 'phone'
  lastShape = result.shape || ''
  lastAt = result.payload.savedAt
  applyPayload(result.payload)
  persist(result.payload, function () {
    if (rev === appliedRev) notify()
  })
  // 这包能用：错误页（如果还亮着）收掉，并解除「同类错误静音」
  resolveXferError()
  notify()
  console.log('[sync] applied rev=' + rev + ' ' + lastShape)
  return { ok: true, shape: lastShape }
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
    // 通道通了，上一次的失败原因立即作废，别让状态卡挂着「超时」
    diagCode = 0
    diagHint = ''
    console.log('[sync] interconnect open, reconnected=', data && data.isReconnected)
    notifyConnected()
    // force：重连事件必须立刻拉一次，不能被节流窗口吞掉。
    // （之前不带 force：开机时通道没连上的失败请求会占掉 15s 窗口，
    // 手机随后连上时这次 reconnect 被节流 → 课表最长等一个轮询周期才同步）
    requestSync('reconnect', true)
    startPolling()
  }
  connect.onclose = function (data) {
    ready = false
    connectNotified = false
    lastError = (data && data.data) || 'closed'
    console.log('[sync] interconnect closed', lastError)
    // 手机断连后停止轮询，避免无效空转；重连时恢复
    stopPolling()
    // 断开后问一次原因：204 是链路/配对问题，1001 是手机端没装，1000 多为签名不一致
    diagnose(false)
  }
  connect.onerror = function (data) {
    ready = false
    connectNotified = false
    lastError = (data && (data.data || data.code)) || 'error'
    console.log('[sync] interconnect error', lastError)
    stopPolling()
    diagnose(false)
  }
}

/**
 * 向手机端请求最新课表。
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
      // 通道本来就没就绪（刚开机 / 刚断线）：这次失败不用排重试队列，
      // onopen 会带 force 再拉一次。否则 3 次退避重试全是白跑，还占着节流窗口。
      if (ready) scheduleRetry()
      diagnose(false)
    }
  })
}

/** 请求发出后若迟迟没有新数据，按 4s→8s→16s 退避重试，最多 MAX_RETRY 次 */
function scheduleRetry() {
  if (retryTimer) return
  const revAtRequest = appliedRev
  const delay = RETRY_DELAY_MS * Math.pow(2, retryCount)
  retryTimer = setTimeout(function () {
    retryTimer = null
    if (appliedRev !== revAtRequest) {
      retryCount = 0
      return
    }
    if (retryCount >= MAX_RETRY) {
      console.log('[sync] retry give up, 手机端没回应')
      retryCount = 0
      // 重试用尽仍没数据：问一次通道为什么不通，把原因留给状态卡
      diagnose(true)
      // 请求发出去了、手机端始终没回一包 —— 这就是「传输课表出错」，
      // 弹错误页（通道诊断结果 diagnose 还没回来，先用已知的 hint）
      reportXferError({ phase: ACTION.REQUEST, code: 'request', hint: diagHint })
      return
    }
    retryCount += 1
    requestSync('retry' + retryCount, true)
  }, delay)
}

/**
 * 页面 onShow 调用：数据过期（或从未同步过）就主动向手机要一次。
 * 打开应用/从表盘回到应用时不再被动等推送。
 */
function ensureFresh(reason) {
  const tag = reason || 'ensure-fresh'
  if (!lastAt || Date.now() - lastAt > STALE_MS) {
    retryCount = 0
    requestSync(tag, true)
    return true
  }
  // 数据还新，但通道没连上时也试一次（可能刚开机/刚重连）
  if (!ready) {
    requestSync(tag)
    return true
  }
  return false
}

/**
 * 启动同步通道：先恢复本地缓存，再监听手机消息
 * 有缓存时即使手机不在身边，页面也能显示上次同步的课表。
 */
function init() {
  // 幂等：app.ux 与页面 onInit 都会调 init()。已经起来过就直接返回，
  // 否则会重复读一遍 storage、重复 notify（首屏多一次无谓的整页重渲染）。
  if (connect) return
  // 缓存必须先读：冷启动时不依赖任何连接状态
  cachePending = true
  // 看门狗：个别平台实现可能不回 storage 回调，1.5s 后强制结束 pending 并通知一次，
  // 页面首帧不会永远等下去（无缓存的首装场景也靠这条路径渲染空态）。
  setTimeout(function () {
    if (cachePending) {
      cachePending = false
      notify()
    }
  }, 1500)
  try {
    storage.get({
      key: STORAGE_KEY,
      success: function (data) {
        cachePending = false
        const raw = readStoredValue(data)
        if (raw && appliedRev === 0) {
          // 手机已经推过数据（更新），不要用旧缓存覆盖
          const result = normalizePayload(raw)
          if (result.ok) {
            cachedAt = result.payload.savedAt || 0
            lastSource = 'cache'
            lastShape = result.shape || ''
            lastAt = cachedAt
            applyPayload(result.payload)
            /* 冷启动恢复出来的课表也要能导出（手环离线时这是唯一的来源） */
            rememberPayload(result.payload)
            console.log('[sync] cache restored, savedAt=' + cachedAt + ' ' + lastShape)
          } else {
            lastError = 'cache rejected: ' + result.error
            console.log('[sync] cache rejected:', result.error)
          }
        }
        // 无论恢复成功与否都通知一次：页面首帧在等这个通知再渲染，
        // 避免缓存还没读回时误判"没数据"闪一下"请连接手机"空态。
        notify()
      },
      fail: function (data, code) {
        cachePending = false
        lastError = 'storage.get fail ' + code
        notify()
      }
    })
  } catch (e) {
    cachePending = false
    lastError = String(e)
    notify()
  }

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
        } else {
          // 开局未就绪是常态（对端 App 没开 / 蓝牙没连），但原因有几种可能：
          // 问一次 diagnosis，把「没装手机端」「超时」「签名不符」区分开；
          // 同时短轮询状态，避免一次误报就整段显示未连接。
          diagnose(true)
          pollReadyState(0)
        }
      },
      fail: function (data, code) {
        lastError = 'getReadyState fail ' + code
        diagnose(true)
        pollReadyState(0)
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

/**
 * 页面不可见（onHide）时暂停 5 分钟轮询：手环上页面切走/息屏后继续轮询纯属白耗电。
 * 页面回来时 onShow 会先 ensureFresh 拉一次，轮询用 resumePolling 恢复。
 */
function pausePolling() {
  stopPolling()
}

/** 恢复轮询：只在通道已就绪时启动；未就绪的话 onopen 会自己起 */
function resumePolling() {
  if (ready) startPolling()
}

function teardown() {
  stopPolling()
  resetExportUi()
  // 下一次 init 是全新的连接，别把上一次进程的失败页 / 静音状态带过来
  resolveXferError()
  if (readyPollTimer) {
    clearTimeout(readyPollTimer)
    readyPollTimer = null
  }
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
  // 下次 init 重新诊断，别把上一次进程的失败原因挂在新连接上
  diagCode = -1
  diagHint = ''
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
    /** 通道诊断码（0 正常 / 204 超时 / 1001 手机端未装 / 1000 其它 / -1 未诊断） */
    diagCode: diagCode,
    /** 诊断码对应的一句话，未连接时展示在状态卡上 */
    diagHint: diagHint,
    /** 整表是否完整（有课表 + 学期起始日），可渲染学期内任意一天 */
    hasFull: schedule.hasFullSemester(),
    /** 是否持有可导出的整表（对端发 action=export 时能给东西） */
    canExport: !!lastPayload,
    /** 回传浮层是否正在显示（对端正在拉课表） */
    exporting: exportActive,
    /** 回传进度 0-100，仅 exporting 时有意义 */
    exportPercent: exportPercent,
    /** 传输失败页是否正在显示（手机推的课表用不了 / 请求后手机没回应） */
    xferError: !!xferError,
    /** 失败页上的日志行（已是可以直接展示的短句） */
    xferErrorLines: xferError ? xferError.lines : []
  }
}

export default {
  ACTION: ACTION,
  PROTOCOL: PROTOCOL,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  PEER_PACKAGE: PEER_PACKAGE,
  init: init,
  teardown: teardown,
  requestSync: requestSync,
  ensureFresh: ensureFresh,
  pausePolling: pausePolling,
  resumePolling: resumePolling,
  diagnose: diagnose,
  handlePhoneMessage: handlePhoneMessage,
  normalizePayload: normalizePayload,
  onScheduleChange: onScheduleChange,
  onExportState: onExportState,
  onXferError: onXferError,
  dismissXferError: dismissXferError,
  getStatus: getStatus,
  isCachePending: function () { return cachePending }
}
