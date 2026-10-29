import type { TFunction } from 'i18next';
import i18n from '../../i18n';
import type { AutomationInfo, DayOfWeek } from '../../types/automations';
import { describeCron, isWeekdays, parseFormSchedule } from './schedule';

/** Format time using locale-appropriate AM/PM or 24-hour format. */
export function formatTime(h: number, m: string, t: TFunction): string {
    const am = t('automations.timePeriodAM');
    const pm = t('automations.timePeriodPM');
    if (!am && !pm) return `${h.toString().padStart(2, '0')}:${m.padStart(2, '0')}`;
    const h12 = h % 12 || 12;
    return `${h12}:${m.padStart(2, '0')} ${h < 12 ? am : pm}`;
}

/** Format days of the week as localized day names joined with "and". */
export function formatDayOfWeek(days: DayOfWeek[], t: TFunction): string {
    const dayNames = days.map(day => t(`automations.days.${day}` as any) as string);
    return dayNames.length > 1
        ? dayNames.slice(0, -1).join(', ') + ' ' + t('automations.and') + ' ' + dayNames[dayNames.length - 1]
        : dayNames[0]!;
}

/** Format day-of-month number with English ordinal suffix when in English locale. */
export function formatDayOfMonth(dom: number): string {
    let dayStr = `${dom}`;
    if (i18n.language.startsWith('en')) {
        const suffixes = ['th', 'st', 'nd', 'rd'];
        const v = dom % 100;
        dayStr = `${dom}${suffixes[(v >= 11 && v <= 13) ? 0 : Math.min(v % 10, 4) > 3 ? 0 : v % 10]}`;
    }
    return dayStr;
}

/**
 * Describe a routine's schedule in plain words, whatever cron Pipali gave it. The card
 * uses the short phrasing, the detail view the long one.
 */
export function formatSchedule(automation: AutomationInfo, t: TFunction, variant: 'short' | 'long'): string {
    if (!automation.triggerType || !automation.triggerConfig) return t('automations.manualOnly');
    if (automation.triggerConfig.type !== 'cron') return t('automations.fileWatchTrigger');

    const { schedule } = automation.triggerConfig;
    const form = parseFormSchedule(schedule);
    if (!form) {
        const use24HourTimeFormat = !t('automations.timePeriodAM');
        return describeCron(schedule, i18n.resolvedLanguage ?? i18n.language, use24HourTimeFormat) ?? t('automations.customSchedule');
    }

    const short = variant === 'short';
    const [hour, minute] = form.time.split(':') as [string, string];
    const time = formatTime(Number(hour), minute, t);
    switch (form.frequency) {
        case 'hour':
            return t(short ? 'automations.hourlyAt' : 'automations.everyHourAt', { minute: String(form.minuteOfHour).padStart(2, '0') });
        case 'week':
            if (isWeekdays(form.daysOfWeek)) return t(short ? 'automations.weekdaysAt' : 'automations.everyWeekdayAt', { time });
            return t(short ? 'automations.weeklyOn' : 'automations.everyDayOfWeekAt', { day: formatDayOfWeek(form.daysOfWeek, t), time });
        case 'month':
            return t(short ? 'automations.monthlyOn' : 'automations.everyDayOfMonthAt', { day: formatDayOfMonth(form.dayOfMonth), time });
        default:
            return t(short ? 'automations.dailyAt' : 'automations.everyDayAt', { time });
    }
}

/**
 * A calendar date as YYYY-MM-DD, the format of date inputs and routine start dates, in the
 * given timezone or else the local one.
 */
export function toDateInputValue(date: Date = new Date(), timeZone?: string): string {
    if (timeZone) {
        try {
            const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
            const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value;
            return `${part('year')}-${part('month')}-${part('day')}`;
        } catch {
            // A timezone the browser does not know reads as the local one
        }
    }
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A routine's start date if its schedule has yet to begin, else empty. */
export function upcomingStartDate(automation: AutomationInfo): string {
    const config = automation.triggerConfig;
    if (config?.type !== 'cron' || !config.startDate) return '';
    // The schedule begins on that day in the routine's timezone, which need not be the browser's
    return config.startDate > toDateInputValue(new Date(), config.timezone) ? config.startDate : '';
}

/** Format a YYYY-MM-DD date for display in the UI language. */
export function formatDate(date: string): string {
    return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(`${date}T00:00`));
}

/**
 * Format a routine's runs, weekday through time, in the UI language. Once any run falls
 * outside the current year they all show their year, so runs a year apart read apart.
 */
export function formatRunTimes(runs: string[]): string[] {
    const dates = runs.map(run => new Date(run));
    const thisYear = new Date().getFullYear();
    const year = dates.some(date => date.getFullYear() !== thisYear) ? 'numeric' : undefined;
    const format = new Intl.DateTimeFormat(i18n.language, { weekday: 'short', year, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return dates.map(date => format.format(date));
}

/** Format next scheduled time as a relative localized string. */
export function formatNextRun(nextScheduledAt: string | undefined, t: TFunction): string | null {
    if (!nextScheduledAt) return null;

    const next = new Date(nextScheduledAt);
    const now = new Date();
    const diffMs = next.getTime() - now.getTime();

    if (diffMs < 0) return t('automations.overdue');

    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
        return t('automations.inDays', { count: diffDays });
    }
    if (diffHours > 0) {
        return t('automations.inHours', { count: diffHours });
    }

    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    if (diffMinutes > 0) {
        return t('automations.inMinutes', { count: diffMinutes });
    }

    return t('automations.soon');
}
