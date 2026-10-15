/**
 * Datas do painel no fuso de São Paulo, o mesmo que o Streamlit usa ao ler o histórico.
 * Um dia é a string AAAA-MM-DD; comparar strings nesse formato compara datas.
 */

export const APP_TIME_ZONE = 'America/Sao_Paulo';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const RAW_DATE_PATTERN = /^(\d{2})[/-](\d{2})[/-](\d{4})/;

const clockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function dayKeyFromDate(date: Date): string {
  return dayFormatter.format(date);
}

/** Hora de São Paulo no formato HH:MM. */
export function clockLabel(date: Date): string {
  return clockFormatter.format(date);
}

/** Minutos desde 00:00 em São Paulo; null se a data for inválida. */
export function minutesOfDaySP(date: Date): number | null {
  if (Number.isNaN(date.getTime())) return null;
  const [hour, minute] = clockFormatter.format(date).split(':').map(Number);
  return hour * 60 + minute;
}

export function todayKey(): string {
  return dayKeyFromDate(new Date());
}

export function shiftDayKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Dias de start a end, incluindo os dois. Intervalo invertido não tem dias. */
export function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (let day = start; day <= end; day = shiftDayKey(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * Dia de uma movimentação: a data gravada no Supabase (UTC) convertida para São Paulo.
 * Se ela não existir, usa a data do texto original do site (dd/mm/aaaa), como o Python faz.
 */
export function eventDayKey(eventAt: string | null | undefined, eventAtRaw: string): string | null {
  if (eventAt) {
    const parsed = new Date(eventAt);
    if (!Number.isNaN(parsed.getTime())) return dayKeyFromDate(parsed);
  }
  const match = RAW_DATE_PATTERN.exec((eventAtRaw || '').trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}
