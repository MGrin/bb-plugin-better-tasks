const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fullDate = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});
const dateTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Compact age: "now", "5m", "3h", "2d", "Sep 12", "Sep 12, 2025". */
export function shortAge(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const age = now - time;
  if (age < MINUTE) return "now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`;
  const date = new Date(time);
  return date.getFullYear() === new Date(now).getFullYear()
    ? monthDay.format(date)
    : fullDate.format(date);
}

export function longDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : dateTime.format(new Date(time));
}

export function plainDate(isoDay: string): string {
  const time = Date.parse(`${isoDay}T00:00:00`);
  return Number.isNaN(time) ? isoDay : fullDate.format(new Date(time));
}

const count = new Intl.NumberFormat();
export function formatCount(value: number): string {
  return count.format(value);
}
