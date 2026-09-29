import type { Schedule } from './types';

/**
 * Local time for the engine: `at` shifted by the device's offset, read back
 * with UTC getters. One offset, the device's current one, is used for every
 * view, old or new, so every platform buckets a view into the same day.
 */

const DAY = 86_400_000;

export function local(at: number, offsetMinutes: number): Date {
  return new Date(at + offsetMinutes * 60_000);
}

/** 1 is Monday and 7 is Sunday; getUTCDay has Sunday as 0. */
function weekday(date: Date): number {
  return date.getUTCDay() === 0 ? 7 : date.getUTCDay();
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function dateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

export function dayOf(at: number, offsetMinutes: number): string {
  return dateKey(local(at, offsetMinutes));
}

/** The date of the Monday that starts the local week holding `at`. */
export function weekOf(at: number, offsetMinutes: number): string {
  const here = local(at, offsetMinutes);
  return dateKey(new Date(here.getTime() - (weekday(here) - 1) * DAY));
}

function inWindow(from: string | null, to: string | null, clock: string): boolean {
  if (from === null || to === null || from === to) return true;
  if (from < to) return clock >= from && clock < to;
  return clock >= from || clock < to;
}

export function inSchedule(schedule: Schedule, at: number, offsetMinutes: number): boolean {
  if (at < schedule.startAt) return false;
  if (schedule.endAt !== null && at >= schedule.endAt) return false;

  const here = local(at, offsetMinutes);
  const clock = `${two(here.getUTCHours())}:${two(here.getUTCMinutes())}`;
  const { from, to, days } = schedule;
  if (!inWindow(from, to, clock)) return false;
  if (days === null) return true;

  // After midnight inside a window that crosses it, the day that counts is the one the window opened on.
  const crossed = from !== null && to !== null && from > to && clock < to;
  return days.includes(weekday(crossed ? new Date(here.getTime() - DAY) : here));
}
