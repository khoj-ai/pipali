// Empty state when no active tasks on home page

import { useState } from 'react';
import { RibbonAnimation } from './RibbonAnimation';
import { useHasDraft, type ComposerDraft } from '../../hooks/useComposerDraft';
import i18n from '../../i18n';

type TimeSlot = 'lateNight' | 'earlyMorning' | 'morning' | 'afternoon' | 'evening' | 'night';

function getTimeOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
    if (hour >= 17 || hour < 4) return 'evening';
    if (hour >= 12) return 'afternoon';
    return 'morning';
}

function getTimeSlot(hour: number): TimeSlot {
    if (hour >= 0 && hour < 4) return 'lateNight';
    if (hour >= 4 && hour < 7) return 'earlyMorning';
    if (hour >= 7 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
}

function isWeekend(day: number): boolean {
    return day === 0 || day === 6;
}

function isFriday(day: number): boolean {
    return day === 5;
}

function isMonday(day: number): boolean {
    return day === 1;
}

export function formatGreetingName(name?: string, language = i18n.resolvedLanguage ?? i18n.language): string {
    const trimmed = name?.trim();
    if (!trimmed) return '';
    if (language.startsWith('ja')) return `、${trimmed}さん`;
    if (language.startsWith('zh')) return `，${trimmed}`;
    return `, ${trimmed}`;
}

function getGreeting(name?: string): string {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();
    const n = formatGreetingName(name);
    const timeOfDay = i18n.t(`home.timeOfDay.${getTimeOfDay(hour)}`);
    const timeSlot = getTimeSlot(hour);
    const weekend = isWeekend(dayOfWeek);

    const greetings: string[] = [
        ...(i18n.t('home.greetings.default', { returnObjects: true }) as string[]),
    ];

    if (timeSlot === 'lateNight') {
        greetings.push(...(i18n.t('home.greetings.lateNight', { returnObjects: true }) as string[]));
    } else if (timeSlot === 'earlyMorning') {
        greetings.push(...(i18n.t('home.greetings.earlyMorning', { returnObjects: true }) as string[]));
    } else if (timeSlot === 'morning') {
        greetings.push(...(i18n.t('home.greetings.morning', { returnObjects: true }) as string[]));
        if (isMonday(dayOfWeek)) {
            greetings.push(...(i18n.t('home.greetings.morningMonday', { returnObjects: true }) as string[]));
        }
    } else if (timeSlot === 'afternoon') {
        greetings.push(...(i18n.t('home.greetings.afternoon', { returnObjects: true }) as string[]));
    } else if (timeSlot === 'evening') {
        greetings.push(...(i18n.t('home.greetings.evening', { returnObjects: true }) as string[]));
        if (isFriday(dayOfWeek)) {
            greetings.push(...(i18n.t('home.greetings.eveningFriday', { returnObjects: true }) as string[]));
        }
    } else {
        greetings.push(...(i18n.t('home.greetings.night', { returnObjects: true }) as string[]));
    }

    if (weekend) {
        greetings.push(...(i18n.t('home.greetings.weekend', { returnObjects: true }) as string[]));
    }

    if (isFriday(dayOfWeek) && timeSlot === 'afternoon') {
        greetings.push(...(i18n.t('home.greetings.fridayAfternoon', { returnObjects: true }) as string[]));
    }

    const greeting = greetings[Math.floor(Math.random() * greetings.length)] as string;
    return greeting.replace(/\{\{name\}\}/g, n).replace(/\{\{timeOfDay\}\}/g, timeOfDay);
}

interface EmptyHomeStateProps {
    userFirstName?: string;
    draft: ComposerDraft;
}

export function EmptyHomeState({ userFirstName, draft }: EmptyHomeStateProps) {
    const [greeting] = useState(() => getGreeting(userFirstName));
    const hasDraft = useHasDraft(draft);

    return (
        <div className="empty-state home-empty">
            <RibbonAnimation resolved={hasDraft} />
            <h2>{greeting}</h2>
        </div>
    );
}
