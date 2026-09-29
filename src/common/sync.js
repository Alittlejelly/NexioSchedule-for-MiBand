/**
 * 手机端 → 手表端 同步接口层
 *
 * 对端应用：手机端课程表（包名 com.haooz.chedule）
 * 主通道：@system.interconnect（与手机 App 双向通信）
 * 本地缓存：@system.storage（冷启动恢复，避免无网/未连接时空白）
 *
 * ---------------------------------------------------------------------------
 * 同步协议（手机端按此结构推送即可，手表端已预留完整入口）
 * ---------------------------------------------------------------------------
 * 消息形态：JSON 字符串或已解析对象，经 connect.onmessage 送达。
 *
 * {
 *   "protocol": "nexio.schedule",
 *   "version": 1,
 *   "action": "replace",          // replace=整周覆盖 | upsert=按天合并 | clear=清空
 *   "sentAt": 1728373680000,      // 可选，手机发送时间戳
 *   "quote": "看得挺认真，就是一点用没有",  // 可选，每日一句
 *   "week": {                     // 键为 0-6（周日-周六），值为课程数组
 *     "4": [
 *       {
 *         "id": "c-1001",         // 可选，稳定唯一 id，用于列表 tid
 *         "name": "移动终端应用及开发技术",
 *         "startTime": "09:10",   // 必填，HH:mm
 *         "endTime": "10:30",     // 必填，HH:mm
 *         "periods": "第4-5节",   // 可选，节次或时间文案（与手机端一致）
 *         "location": "通信工程实训室",
 *         "teacher": "谭婷芳",
 *         "section": "morning"    // 可选，缺省时按 startTime 自动推断
 *       }
 *     ]
 *   }
 * }
 *
 * 也支持按具体日期推送（与手机端「今日」页对齐）：
 * {
 *   "protocol": "nexio.schedule",
 *   "version": 1,
 *   "action": "replace",
 *   "days": [
 *     { "date": "2026-10-08", "weekday": 4, "courses": [ /* 同上 Course * / ] }
 *   ]
 * }
 *
 * 手表端可回传（requestSync）：
 * { "protocol": "nexio.schedule", "version": 1, "action": "request", "reason": "app-open" }
 *
 * 注意：interconnect 要求手表 rpk 与手机 App 包名、签名一致。
 * 当前手表包名 com.example.bandschedule，真机联调前需改为 com.haooz.chedule，
 * 并使用手机端同一套签名证书。
 */

import interconnect from '@system.interconnect'
import storage from '@system.storage'
import schedule from './schedule'

const PROTOCOL = 'nexio.schedule'
const PROTOCOL_VERSION = 1
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
let connect = null
let ready = false
let lastError = null
let cachedQuote = ''
/** 已应用的最新同步序号，用于丢弃晚到的旧 storage 缓存 */
let appliedRev = 0

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

function normalizeCourse(item, index, dayKey) {
  if (!isPlainObject(item)) return null
  const name = item.name || item.courseName || item.title || ''
  const startTime = item.startTime || item.start || ''
  const endTime = item.endTime || item.end || ''
  if (!name || !startTime || !endTime) return null

  const periods = item.periods || item.period || item.sectionText || ''
  const location = item.location || item.place || item.classroom || ''
  const teacher = item.teacher || item.instructor || ''
  const section = schedule.resolveSection(item.section, startTime)

  let id = item.id != null ? String(item.id) : ''
  if (!id) {
    id = dayKey + '-' + startTime.replace(':', '') + '-' + index
  }

  return {
    id: id,
    name: name,
    startTime: startTime,
    endTime: endTime,
    periods: periods,
    location: location,
    teacher: teacher,
    section: section
  }
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
  const msg = parseMessage(raw)
  if (!msg) {
    return { ok: false, error: 'empty payload' }
  }
  if (msg.protocol && msg.protocol !== PROTOCOL) {
    return { ok: false, error: 'protocol mismatch: ' + msg.protocol }
  }
  const version = msg.version != null ? Number(msg.version) : PROTOCOL_VERSION
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported version: ' + version }
  }

  const action = msg.action || ACTION.REPLACE
  const week = {}
  for (let i = 0; i < 7; i++) week[i] = []

  if (action === ACTION.CLEAR) {
    return {
      ok: true,
      payload: {
        protocol: PROTOCOL,
        version: PROTOCOL_VERSION,
        action: ACTION.CLEAR,
        quote: msg.quote || '',
        week: week
      }
    }
  }

  if (isPlainObject(msg.week)) {
    const keys = Object.keys(msg.week)
    for (let i = 0; i < keys.length; i++) {
      const key = String(keys[i])
      const day = parseInt(key, 10)
      if (isNaN(day) || day < 0 || day > 6) {
        return { ok: false, error: 'invalid weekday key: ' + key }
      }
      week[day] = normalizeCourseList(msg.week[key], String(day))
    }
  } else if (Array.isArray(msg.days)) {
    for (let i = 0; i < msg.days.length; i++) {
      const dayItem = msg.days[i] || {}
      let day = dayItem.weekday
      if (day == null && dayItem.date) {
        const d = new Date(dayItem.date)
        if (!isNaN(d.getTime())) day = d.getDay()
      }
      day = parseInt(day, 10)
      if (isNaN(day) || day < 0 || day > 6) {
        return { ok: false, error: 'invalid day entry index ' + i }
      }
      week[day] = normalizeCourseList(dayItem.courses, String(day))
    }
  } else if (action !== ACTION.ACK) {
    return { ok: false, error: 'missing week/days' }
  }

  return {
    ok: true,
    payload: {
      protocol: PROTOCOL,
      version: PROTOCOL_VERSION,
      action: action,
      sentAt: msg.sentAt || Date.now(),
      quote: msg.quote || '',
      week: week
    }
  }
}

function persist(payload, done) {
  try {
    storage.set({
      key: STORAGE_KEY,
      value: JSON.stringify(payload),
      success: function () {
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
  } else if (payload.action === ACTION.UPSERT) {
    schedule.mergeWeek(payload.week || {})
  } else {
    schedule.replaceWeek(payload.week || {})
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
  applyPayload(result.payload)
  persist(result.payload, function () {
    if (rev === appliedRev) notify()
  })
  // 若 storage 回调异常延迟，也先通知一次保证 UI 及时刷新
  notify()
  console.log('[sync] applied rev=' + rev + ' action=' + result.payload.action)
  return { ok: true }
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
    requestSync('reconnect')
  }
  connect.onclose = function (data) {
    ready = false
    lastError = (data && data.data) || 'closed'
    console.log('[sync] interconnect closed', lastError)
  }
  connect.onerror = function (data) {
    ready = false
    lastError = (data && (data.data || data.code)) || 'error'
    console.log('[sync] interconnect error', lastError)
  }
}

/**
 * 向手机端请求最新课表
 */
function requestSync(reason) {
  if (!connect) return
  const body = {
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    action: ACTION.REQUEST,
    reason: reason || 'manual',
    sentAt: Date.now()
  }
  connect.send({
    data: body,
    success: function () {
      console.log('[sync] request sent')
    },
    fail: function (data, code) {
      lastError = 'request fail ' + code
      console.log('[sync] request fail', lastError)
    }
  })
}

/**
 * 启动同步通道：恢复缓存 + 监听手机消息
 */
function init() {
  if (connect) return
  try {
    connect = interconnect.instance()
    bindConnect()
    connect.getReadyState({
      success: function (data) {
        ready = !!(data && data.status === 1)
        if (ready) requestSync('app-open')
      },
      fail: function (data, code) {
        lastError = 'getReadyState fail ' + code
      }
    })
  } catch (e) {
    lastError = String(e)
    console.log('[sync] init fail', lastError)
    return
  }

  try {
    storage.get({
      key: STORAGE_KEY,
      success: function (data) {
        if (!data) return
        // 已收到更新的手机推送时，忽略晚到的旧缓存
        if (appliedRev > 0) return
        const result = normalizePayload(data)
        if (result.ok) {
          applyPayload(result.payload)
          notify()
        }
      },
      fail: function (data, code) {
        lastError = 'storage.get fail ' + code
      }
    })
  } catch (e) {
    lastError = String(e)
  }
}

function teardown() {
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

function getStatus() {
  return {
    ready: ready,
    lastError: lastError,
    peerPackage: PEER_PACKAGE,
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION
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
  handlePhoneMessage: handlePhoneMessage,
  normalizePayload: normalizePayload,
  onScheduleChange: onScheduleChange,
  getStatus: getStatus
}
