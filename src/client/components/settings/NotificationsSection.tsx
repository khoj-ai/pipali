import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bell, Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
    disablePush,
    enablePush,
    forgetPushDevice,
    getPushState,
    listPushDevices,
    type PushDevice,
    type PushState,
} from '../../utils/push';

export function NotificationsSection() {
    const { t, i18n } = useTranslation();
    const [state, setState] = useState<PushState | null>(null);
    const [devices, setDevices] = useState<PushDevice[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setState(await getPushState());
        setDevices(await listPushDevices());
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    // The permission prompt has to be raised from the click itself, so this stays on the
    // handler rather than moving into an effect.
    const toggle = async (on: boolean) => {
        setBusy(true);
        setError(null);
        try {
            if (on) setState(await enablePush());
            else {
                await disablePush();
                setState('off');
            }
            setDevices(await listPushDevices());
        } catch (err) {
            setError(err instanceof Error ? err.message : t('notifications.push.failed'));
            setState(await getPushState());
        } finally {
            setBusy(false);
        }
    };

    const forget = async (id: number) => {
        await forgetPushDevice(id);
        await refresh();
    };

    const formatWhen = (iso: string) => new Date(iso).toLocaleString(i18n.language);

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3 className="settings-section-title">
                        <Bell size={18} />
                        {t('notifications.push.title')}
                    </h3>
                    <p className="settings-section-description">
                        {t('notifications.push.description')}
                    </p>
                </div>
                <label className="toggle-switch">
                    <input
                        id="push-enabled"
                        type="checkbox"
                        checked={state === 'on'}
                        disabled={busy || state === null || state === 'unsupported' || state === 'denied'}
                        onChange={(e) => void toggle(e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                </label>
            </div>

            {state === 'unsupported' && (
                <p className="settings-field-hint">{t('notifications.push.unsupported')}</p>
            )}
            {state === 'denied' && (
                <p className="settings-field-hint">{t('notifications.push.denied')}</p>
            )}
            {error && (
                <div className="settings-error">
                    <AlertCircle size={14} />
                    <span>{error}</span>
                </div>
            )}

            {/* Devices are listed whatever this browser's own state is: the point is to see
                and revoke the phones being notified, which is rarely the machine you are on. */}
            {devices.length > 0 ? (
                <>
                    <p className="settings-field-hint">{t('notifications.push.devices')}</p>
                    <ul className="settings-device-list">
                        {devices.map((device) => (
                            <li key={device.id} className="settings-device">
                                <span className="settings-device-label">{device.label}</span>
                                <span className="settings-device-meta">
                                    {device.lastNotifiedAt
                                        ? t('notifications.push.lastNotified', { when: formatWhen(device.lastNotifiedAt) })
                                        : t('notifications.push.never')}
                                </span>
                                <button
                                    type="button"
                                    className="settings-device-remove"
                                    title={t('notifications.push.remove')}
                                    aria-label={t('notifications.push.remove')}
                                    onClick={() => void forget(device.id)}
                                >
                                    <Trash2 size={14} />
                                </button>
                            </li>
                        ))}
                    </ul>
                </>
            ) : (
                state !== 'unsupported' && <p className="settings-field-hint">{t('notifications.push.noDevices')}</p>
            )}

            {busy && <Loader2 size={14} className="settings-spinner" />}
        </div>
    );
}
