import { describe, expect, it } from 'vitest'
import { formatDuration, minutesSince } from './format'

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
