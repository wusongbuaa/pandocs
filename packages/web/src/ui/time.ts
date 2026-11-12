import { language, t } from "../i18n";

const LOCALE = language === "zh" ? "zh-CN" : "en";

/** Short enough for a comment header; the exact time is in the element's title. */
export function relativeTime(value: string, now = new Date()): string {
  const at = new Date(value);
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{0} min ago", minutes);
  // hourCycle, because with hour12 off some browsers write midnight as 24:00 in English.
  const clock = at.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000);
  if (days === 0) return t("today {0}", clock);
  if (days === 1) return t("yesterday {0}", clock);
  const date = at.toLocaleDateString(LOCALE, { month: "short", day: "numeric", ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
  return `${date} ${clock}`;
}

/** Records need the moment itself, not how long ago it was. */
export function formatTime(value: string): string {
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
