/**
 * Reset schedule handling for openclaw-smart-router
 */

import type { ResetSchedule, ResetScheduleType } from "../types.js";
import { log } from "../logger.js";

// =============================================================================
// Reset Time Calculation
// =============================================================================

/**
 * Calculate the next reset time for a schedule
 */
export function calculateNextReset(schedule: ResetSchedule): Date {
  const now = new Date();

  switch (schedule.type) {
    case "daily":
      return calculateDailyReset(now, schedule);
    case "weekly":
      return calculateWeeklyReset(now, schedule);
    case "monthly":
      return calculateMonthlyReset(now, schedule);
    case "fixed":
      return calculateFixedReset(schedule);
  }
}

/**
 * Calculate next daily reset
 */
function calculateDailyReset(now: Date, schedule: ResetSchedule): Date {
  const hour = schedule.hour ?? 0;
  const next = new Date(now);

  next.setHours(hour, 0, 0, 0);

  // If we've passed today's reset time, move to tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return applyTimezone(next, schedule.timezone);
}

/**
 * Calculate next weekly reset
 */
function calculateWeeklyReset(now: Date, schedule: ResetSchedule): Date {
  const dayOfWeek = schedule.dayOfWeek ?? 0; // Default to Sunday
  const hour = schedule.hour ?? 0;

  const next = new Date(now);
  const currentDay = next.getDay();
  let daysUntil = dayOfWeek - currentDay;

  if (daysUntil < 0) {
    daysUntil += 7;
  } else if (daysUntil === 0) {
    // Check if we've passed the reset time today
    next.setHours(hour, 0, 0, 0);
    if (next <= now) {
      daysUntil = 7;
    }
  }

  next.setDate(next.getDate() + daysUntil);
  next.setHours(hour, 0, 0, 0);

  return applyTimezone(next, schedule.timezone);
}

/**
 * Calculate next monthly reset
 */
function calculateMonthlyReset(now: Date, schedule: ResetSchedule): Date {
  const dayOfMonth = schedule.dayOfMonth ?? 1;
  const hour = schedule.hour ?? 0;

  const next = new Date(now);
  next.setDate(dayOfMonth);
  next.setHours(hour, 0, 0, 0);

  // If we've passed this month's reset, move to next month
  if (next <= now) {
    next.setMonth(next.getMonth() + 1);
  }

  // Handle months with fewer days
  const targetMonth = next.getMonth();
  if (next.getDate() !== dayOfMonth) {
    // We overflowed to the next month, go to last day of target month
    next.setDate(0);
  }

  return applyTimezone(next, schedule.timezone);
}

/**
 * Calculate fixed reset time
 */
function calculateFixedReset(schedule: ResetSchedule): Date {
  if (!schedule.fixedDate) {
    log.warn("fixed schedule missing fixedDate, using tomorrow");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow;
  }

  const fixed = new Date(schedule.fixedDate);
  if (isNaN(fixed.getTime())) {
    log.warn(`invalid fixedDate: ${schedule.fixedDate}, using tomorrow`);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow;
  }

  return fixed;
}

/**
 * Apply timezone offset (basic implementation)
 *
 * For full timezone support, consider using a library like date-fns-tz
 */
function applyTimezone(date: Date, timezone?: string): Date {
  if (!timezone || timezone === "UTC") {
    return date;
  }

  // For common US timezones, apply offset
  const offsets: Record<string, number> = {
    "America/New_York": -5,
    "America/Chicago": -6,
    "America/Denver": -7,
    "America/Los_Angeles": -8,
    EST: -5,
    CST: -6,
    MST: -7,
    PST: -8,
  };

  const offset = offsets[timezone];
  if (offset !== undefined) {
    // This is a simplification - doesn't handle DST
    const utcDate = new Date(date.getTime() + date.getTimezoneOffset() * 60000);
    return new Date(utcDate.getTime() + offset * 3600000);
  }

  // If we don't recognize the timezone, return as-is
  log.debug(`unrecognized timezone: ${timezone}, using local time`);
  return date;
}

/**
 * Get a human-readable description of when reset occurs
 */
export function describeResetSchedule(schedule: ResetSchedule): string {
  const hour = schedule.hour ?? 0;
  const hourStr = hour === 0 ? "midnight" : `${hour}:00`;
  const tz = schedule.timezone ?? "UTC";

  switch (schedule.type) {
    case "daily":
      return `Daily at ${hourStr} ${tz}`;

    case "weekly": {
      const days = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      const day = days[schedule.dayOfWeek ?? 0];
      return `Every ${day} at ${hourStr} ${tz}`;
    }

    case "monthly": {
      const dom = schedule.dayOfMonth ?? 1;
      const suffix =
        dom === 1 ? "st" : dom === 2 ? "nd" : dom === 3 ? "rd" : "th";
      return `Monthly on the ${dom}${suffix} at ${hourStr} ${tz}`;
    }

    case "fixed":
      return schedule.fixedDate
        ? `Fixed: ${new Date(schedule.fixedDate).toLocaleString()}`
        : "Fixed (date not set)";
  }
}

/**
 * Parse a reset schedule from a simple string format
 *
 * Examples:
 * - "daily" -> daily at midnight UTC
 * - "daily:7" -> daily at 7:00 UTC
 * - "weekly:1:9" -> weekly on Monday at 9:00 UTC
 * - "monthly:15:0" -> monthly on 15th at midnight UTC
 * - "2024-03-01T00:00:00Z" -> fixed date
 */
export function parseResetSchedule(input: string): ResetSchedule {
  // Check for ISO date format
  if (input.includes("T") || input.includes("-")) {
    return { type: "fixed", fixedDate: input };
  }

  const parts = input.toLowerCase().split(":");
  const type = parts[0] as ResetScheduleType;

  switch (type) {
    case "daily":
      return {
        type: "daily",
        hour: parts[1] ? parseInt(parts[1], 10) : 0,
      };

    case "weekly":
      return {
        type: "weekly",
        dayOfWeek: parts[1] ? parseInt(parts[1], 10) : 0,
        hour: parts[2] ? parseInt(parts[2], 10) : 0,
      };

    case "monthly":
      return {
        type: "monthly",
        dayOfMonth: parts[1] ? parseInt(parts[1], 10) : 1,
        hour: parts[2] ? parseInt(parts[2], 10) : 0,
      };

    default:
      log.warn(`unknown reset schedule type: ${type}, defaulting to monthly`);
      return { type: "monthly", dayOfMonth: 1 };
  }
}

/**
 * Check if a reset is due (current time >= next reset time)
 */
export function isResetDue(nextReset: number): boolean {
  return Date.now() >= nextReset;
}

/**
 * Calculate hours until next reset
 */
export function hoursUntilReset(nextReset: number): number {
  const ms = nextReset - Date.now();
  return Math.max(0, ms / (60 * 60 * 1000));
}
