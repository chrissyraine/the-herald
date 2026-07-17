import { describe, it, expect } from 'vitest';
import { computeHoursStatus } from '../public/_worker.js';

const TODAY = '2026-07-17';

describe('computeHoursStatus', () => {
  it('reports unknown when no weekly row exists', () => {
    expect(computeHoursStatus(null, null, TODAY)).toEqual({ status: 'unknown', open_time: null, close_time: null, note: null });
  });

  it('reports unknown when a row exists but has no real hours (bare override row)', () => {
    const hours = { open_time: null, close_time: null, is_closed: 0, is_24h: 0, appointment_only: 0, override_status: null, override_note: null, override_date: null };
    expect(computeHoursStatus(hours, null, TODAY).status).toBe('unknown');
  });

  it('reports closed when is_closed is set', () => {
    const hours = { open_time: null, close_time: null, is_closed: 1, is_24h: 0, appointment_only: 0 };
    expect(computeHoursStatus(hours, null, TODAY).status).toBe('closed');
  });

  it('reports open with real hours on file', () => {
    const hours = { open_time: '09:00', close_time: '17:00', is_closed: 0, is_24h: 0, appointment_only: 0 };
    const r = computeHoursStatus(hours, null, TODAY);
    expect(r).toEqual({ status: 'open', open_time: '09:00', close_time: '17:00', note: null });
  });

  it('reports open_24h when the day is flagged 24 hours', () => {
    const hours = { open_time: null, close_time: null, is_closed: 0, is_24h: 1, appointment_only: 0 };
    expect(computeHoursStatus(hours, null, TODAY).status).toBe('open_24h');
  });

  it('reports appointment_only when flagged', () => {
    const hours = { open_time: null, close_time: null, is_closed: 0, is_24h: 0, appointment_only: 1 };
    expect(computeHoursStatus(hours, null, TODAY).status).toBe('appointment_only');
  });

  it('a same-day override wins over real weekly hours', () => {
    const hours = {
      open_time: '09:00', close_time: '17:00', is_closed: 0, is_24h: 0, appointment_only: 0,
      override_status: 'closed', override_note: 'Closed for a private event', override_date: TODAY,
    };
    const r = computeHoursStatus(hours, null, TODAY);
    expect(r.status).toBe('closed');
    expect(r.note).toBe('Closed for a private event');
  });

  it('ignores an override stamped for a different date', () => {
    const hours = {
      open_time: '09:00', close_time: '17:00', is_closed: 0, is_24h: 0, appointment_only: 0,
      override_status: 'closed', override_note: 'stale', override_date: '2026-01-01',
    };
    expect(computeHoursStatus(hours, null, TODAY).status).toBe('open');
  });

  it('ignores an override with an unrecognized status (malformed row)', () => {
    const hours = {
      open_time: '09:00', close_time: '17:00', is_closed: 0, is_24h: 0, appointment_only: 0,
      override_status: 'garbage', override_note: null, override_date: TODAY,
    };
    expect(computeHoursStatus(hours, null, TODAY).status).toBe('open');
  });

  it('a dated exception for today wins over BOTH weekly hours and the same-day override', () => {
    const hours = {
      open_time: '09:00', close_time: '17:00', is_closed: 0, is_24h: 0, appointment_only: 0,
      override_status: 'closed', override_note: 'override note', override_date: TODAY,
    };
    const exception = { status: 'open_special', open_time: '10:00', close_time: '14:00', note: 'Holiday hours' };
    const r = computeHoursStatus(hours, exception, TODAY);
    expect(r).toEqual({ status: 'open_special', open_time: '10:00', close_time: '14:00', note: 'Holiday hours' });
  });

  it('a dated exception can apply even with no weekly row at all', () => {
    const exception = { status: 'closed', open_time: null, close_time: null, note: 'Holiday' };
    const r = computeHoursStatus(null, exception, TODAY);
    expect(r.status).toBe('closed');
    expect(r.note).toBe('Holiday');
  });
});
