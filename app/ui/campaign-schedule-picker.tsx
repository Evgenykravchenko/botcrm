"use client";

import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Globe2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppSelect } from "./app-select";

export const campaignTimeZones = [
  { value: "Europe/Moscow", label: "Москва", detail: "UTC+3" },
  { value: "Europe/Kaliningrad", label: "Калининград", detail: "UTC+2" },
  { value: "Asia/Yekaterinburg", label: "Екатеринбург", detail: "UTC+5" },
  { value: "Asia/Omsk", label: "Омск", detail: "UTC+6" },
  { value: "Asia/Novosibirsk", label: "Новосибирск", detail: "UTC+7" },
  { value: "Asia/Irkutsk", label: "Иркутск", detail: "UTC+8" },
  { value: "Asia/Yakutsk", label: "Якутск", detail: "UTC+9" },
  { value: "Asia/Vladivostok", label: "Владивосток", detail: "UTC+10" },
] as const;

type ZonedFields = { year: number; month: number; day: number; hour: number; minute: number };

function zonedFields(value: Date, timeZone: string): ZonedFields {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute") };
}

function zonedDateTimeToIso(fields: ZonedFields, timeZone: string) {
  const wallClock = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
  let instant = wallClock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const atZone = zonedFields(new Date(instant), timeZone);
    const represented = Date.UTC(atZone.year, atZone.month - 1, atZone.day, atZone.hour, atZone.minute);
    instant += wallClock - represented;
  }
  return new Date(instant).toISOString();
}

function dateKey(fields: Pick<ZonedFields, "year" | "month" | "day">) {
  return `${fields.year}-${String(fields.month).padStart(2, "0")}-${String(fields.day).padStart(2, "0")}`;
}

function formatZoneOffset(timeZone: string, date: Date) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(date).find((item) => item.type === "timeZoneName")?.value ?? "GMT";
  return part.replace("GMT", "UTC").replace("UTC+0", "UTC");
}

export function campaignTimeZoneLabel(timeZone: string) {
  return campaignTimeZones.find((zone) => zone.value === timeZone)?.label ?? timeZone;
}

function formatInZone(value: Date, timeZone: string, includeYear = true) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "numeric",
    month: "long",
    ...(includeYear ? { year: "numeric" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export function defaultCampaignSchedule(timeZone = "Europe/Moscow") {
  const next = new Date(Date.now() + 86_400_000);
  const fields = zonedFields(next, timeZone);
  fields.minute = 0;
  return zonedDateTimeToIso(fields, timeZone);
}

export function CampaignSchedulePicker({
  value,
  timeZone,
  onChange,
  onTimeZoneChange,
}: {
  value: string;
  timeZone: string;
  onChange: (iso: string) => void;
  onTimeZoneChange: (timeZone: string) => void;
}) {
  const selected = useMemo(() => new Date(value), [value]);
  const selectedFields = useMemo(() => zonedFields(selected, timeZone), [selected, timeZone]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [viewMonth, setViewMonth] = useState(() => ({ year: selectedFields.year, month: selectedFields.month }));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setViewMonth({ year: selectedFields.year, month: selectedFields.month }), [selectedFields.year, selectedFields.month]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  const today = zonedFields(now, timeZone);
  const firstWeekday = (new Date(Date.UTC(viewMonth.year, viewMonth.month - 1, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(viewMonth.year, viewMonth.month, 0)).getUTCDate();
  const previousMonthDays = new Date(Date.UTC(viewMonth.year, viewMonth.month - 1, 0)).getUTCDate();
  const calendarDays = Array.from({ length: 42 }, (_, index) => {
    const day = index - firstWeekday + 1;
    const base = new Date(Date.UTC(viewMonth.year, viewMonth.month - 1, day));
    return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(), outside: day < 1 || day > daysInMonth, previousMonthDays };
  });
  const monthTitle = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(viewMonth.year, viewMonth.month - 1, 1)));
  const currentZoneTime = new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(now);
  const moscowTime = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }).format(now);
  const isPast = selected.valueOf() <= now.valueOf();

  function update(patch: Partial<ZonedFields>) {
    onChange(zonedDateTimeToIso({ ...selectedFields, ...patch }, timeZone));
  }
  function moveMonth(direction: -1 | 1) {
    const next = new Date(Date.UTC(viewMonth.year, viewMonth.month - 1 + direction, 1));
    setViewMonth({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 });
  }
  function chooseDay(day: typeof calendarDays[number]) {
    const candidate = { ...selectedFields, year: day.year, month: day.month, day: day.day };
    const iso = zonedDateTimeToIso(candidate, timeZone);
    if (new Date(iso).valueOf() <= now.valueOf()) return;
    onChange(iso);
  }
  function changeTimeZone(nextTimeZone: string) {
    onChange(zonedDateTimeToIso(selectedFields, nextTimeZone));
    onTimeZoneChange(nextTimeZone);
  }

  return <section className="campaign-schedule" ref={rootRef}>
    <div className="campaign-schedule-heading">
      <div><CalendarDays size={17} /><span><b>Дата и время запуска</b><small>Время рассчитывается в выбранном часовом поясе</small></span></div>
      <span className="campaign-zone-badge"><Globe2 size={13} />{campaignTimeZoneLabel(timeZone)} · {formatZoneOffset(timeZone, selected)}</span>
    </div>
    <div className="campaign-schedule-controls">
      <button type="button" className={`campaign-date-trigger ${open ? "open" : ""}`} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <CalendarDays size={17} />
        <span><small>Дата отправки</small><b>{formatInZone(selected, timeZone, false)}</b></span>
        <ChevronRight size={16} />
      </button>
      <AppSelect
        ariaLabel="Часовой пояс рассылки"
        value={timeZone}
        onValueChange={changeTimeZone}
        matchTriggerWidth
        options={campaignTimeZones.map((zone) => ({ ...zone, icon: <Globe2 size={15} /> }))}
      />
    </div>
    {open && <div className="campaign-calendar-popover">
      <div className="campaign-calendar-head">
        <button type="button" aria-label="Предыдущий месяц" onClick={() => moveMonth(-1)}><ChevronLeft size={17} /></button>
        <b>{monthTitle}</b>
        <button type="button" aria-label="Следующий месяц" onClick={() => moveMonth(1)}><ChevronRight size={17} /></button>
      </div>
      <div className="campaign-calendar-weekdays">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="campaign-calendar-grid">{calendarDays.map((item, index) => {
        const key = dateKey(item);
        const candidateEnd = zonedDateTimeToIso({ year: item.year, month: item.month, day: item.day, hour: 23, minute: 59 }, timeZone);
        const disabled = new Date(candidateEnd).valueOf() <= now.valueOf();
        return <button type="button" key={`${key}-${index}`} disabled={disabled} className={`${item.outside ? "outside" : ""} ${key === dateKey(selectedFields) ? "selected" : ""} ${key === dateKey(today) ? "today" : ""}`} onClick={() => chooseDay(item)}>{item.day}</button>;
      })}</div>
      <div className="campaign-time-row">
        <span><Clock3 size={15} />Время</span>
        <AppSelect compact ariaLabel="Час запуска" value={String(selectedFields.hour).padStart(2, "0")} onValueChange={(hour) => update({ hour: Number(hour) })} menuWidth={92} options={Array.from({ length: 24 }, (_, hour) => ({ value: String(hour).padStart(2, "0"), label: String(hour).padStart(2, "0") }))} />
        <i>:</i>
        <AppSelect compact ariaLabel="Минуты запуска" value={String(selectedFields.minute).padStart(2, "0")} onValueChange={(minute) => update({ minute: Number(minute) })} menuWidth={92} options={Array.from({ length: 60 }, (_, minute) => ({ value: String(minute).padStart(2, "0"), label: String(minute).padStart(2, "0") }))} />
      </div>
    </div>}
    <div className={`campaign-time-summary ${isPast ? "error" : ""}`}>
      <Clock3 size={16} />
      <span><b>{isPast ? "Выберите будущее время" : `Запуск: ${formatInZone(selected, timeZone)} · ${campaignTimeZoneLabel(timeZone)}`}</b><small>Сейчас: {currentZoneTime} ({campaignTimeZoneLabel(timeZone)}){timeZone !== "Europe/Moscow" ? ` · ${moscowTime} по Москве` : " по Москве"}</small></span>
    </div>
  </section>;
}
