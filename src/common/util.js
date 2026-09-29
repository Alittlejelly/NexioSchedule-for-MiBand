/**
 * 通用工具：日期与倒计时文案
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function getWeekday(date) {
  return WEEKDAYS[date.getDay()]
}

function formatDate(date) {
  return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日'
}

function formatClock(date) {
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/**
 * 将 "HH:mm" 解析为当天的 Date
 */
function parseTimeToday(timeStr, baseDate) {
  const base = baseDate || new Date()
  const parts = timeStr.split(':')
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0)
  return d
}

/**
 * 倒计时文案：N小时M分钟后 / N分钟后 / 已开始 / 已结束
 */
function formatCountdown(target, now) {
  const diff = target.getTime() - now.getTime()
  if (diff <= 0) {
    return {
      text: '已开始',
      ended: true,
      upcoming: false
    }
  }
  const totalMin = Math.floor(diff / 60000)
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  let text
  if (hours > 0) {
    text = hours + '小时' + mins + '分钟后'
  } else if (mins > 0) {
    text = mins + '分钟后'
  } else {
    text = '即将开始'
  }
  return {
    text: text,
    ended: false,
    upcoming: true
  }
}

/**
 * 课程状态：未开始 / 进行中 / 已结束
 */
function getCourseStatus(course, now) {
  const start = parseTimeToday(course.startTime, now)
  const end = parseTimeToday(course.endTime, now)
  if (now.getTime() < start.getTime()) {
    return {
      status: '未开始',
      countdown: formatCountdown(start, now)
    }
  }
  if (now.getTime() < end.getTime()) {
    return {
      status: '进行中',
      countdown: {
        text: '上课中',
        ended: true,
        upcoming: false
      }
    }
  }
  return {
    status: '已结束',
    countdown: {
      text: '已结束',
      ended: true,
      upcoming: false
    }
  }
}

export default {
  getWeekday,
  formatDate,
  formatClock,
  parseTimeToday,
  formatCountdown,
  getCourseStatus
}
