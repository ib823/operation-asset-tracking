import { describe, expect, it } from 'vitest'
import { formatDuration, formatSignalValue, formatStatus, minutesSince } from './format'

describe('formatDuration', () => {
  it('formats minutes', () => {
    expect(formatDuration(45)).toBe('45m')
  })

  it('formats hours and minutes', () => {
    expect(formatDuration(200)).toBe('3h 20m')
  })

  it('drops the minutes component when it is zero', () => {
    expect(formatDuration(180)).toBe('3h')
  })

  it('formats days and hours — the shape an idle-asset report needs', () => {
    expect(formatDuration(8880)).toBe('6d 4h')
  })

  it('drops the hours component when it is zero', () => {
    expect(formatDuration(2880)).toBe('2d')
  })

  it('renders a dash rather than "0m" for sub-minute and invalid durations', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})

describe('minutesSince', () => {
  const now = new Date('2026-07-16T12:00:00Z')

  it('measures elapsed minutes', () => {
    expect(minutesSince(new Date('2026-07-16T11:00:00Z'), now)).toBe(60)
  })

  it('accepts an ISO string, as serialised API payloads carry', () => {
    expect(minutesSince('2026-07-16T11:30:00Z', now)).toBe(30)
  })

  it('returns null when there is no timestamp', () => {
    expect(minutesSince(null, now)).toBeNull()
  })

  it('clamps a future timestamp to zero rather than reporting negative idle time', () => {
    expect(minutesSince(new Date('2026-07-16T13:00:00Z'), now)).toBe(0)
  })
})

describe('formatStatus', () => {
  it('humanises status enums', () => {
    expect(formatStatus('IN_USE')).toBe('In use')
    expect(formatStatus('UNDER_REPAIR')).toBe('Under repair')
  })
  it('passes through an unknown status rather than blanking it', () => {
    expect(formatStatus('MYSTERY')).toBe('MYSTERY')
  })
})

describe('formatSignalValue', () => {
  it('labels utilisation by busy flag, not raw JSON', () => {
    expect(formatSignalValue('utilisation', { busy: true })).toBe('Busy')
    expect(formatSignalValue('utilisation', { busy: false })).toBe('Not busy')
  })
  it('labels a heartbeat as reachable — presence, never activity', () => {
    expect(formatSignalValue('heartbeat', {})).toBe('Reachable')
  })
  it('shows idle duration when present', () => {
    expect(formatSignalValue('idle', { idleMinutes: 200 })).toBe('Idle 3h 20m')
    expect(formatSignalValue('idle', {})).toBe('Idle')
  })
  it('labels location and status readably', () => {
    expect(formatSignalValue('location', { location: 'Bench 2' })).toBe('Location: Bench 2')
    expect(formatSignalValue('status', { status: 'IN_USE' })).toBe('Status: In use')
  })
  it('never throws on a malformed or null value', () => {
    expect(formatSignalValue('utilisation', null)).toBe('Utilisation')
    expect(formatSignalValue('heartbeat', undefined)).toBe('Reachable')
  })
})
