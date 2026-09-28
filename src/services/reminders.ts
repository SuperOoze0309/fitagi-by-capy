import { Capacitor } from '@capacitor/core';
import { Camera } from '@capacitor/camera';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { Reminder } from '../domain/types';
import { minutesOfDay } from '../repositories/planRepository';

/**
 * The two native capabilities the app asks for, and the reminder scheduler.
 *
 * Every entry point is guarded twice: by `Capacitor.isNativePlatform()` (a browser
 * has no camera permission to ask for and no notification scheduler) and by
 * try/catch (a plugin can be missing from an older native project). Nothing here may
 * ever break the launch path — asking for a permission is not worth a white screen.
 */

export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** Camera *and* the photo library, because a meal can be photographed or picked. */
export async function cameraPermissionState(): Promise<PermissionState> {
  if (!Capacitor.isNativePlatform()) return 'unsupported';
  try {
    const status = await Camera.checkPermissions();
    return combine([status.camera, status.photos]);
  } catch (error) {
    console.warn('[permissions] camera state unavailable', error);
    return 'unsupported';
  }
}

/**
 * Ask for camera and photo access.
 *
 * Resolves to the resulting state rather than throwing: a refusal is a normal answer,
 * and the caller has to keep working with manual entry either way.
 */
export async function requestCameraPermissions(): Promise<PermissionState> {
  if (!Capacitor.isNativePlatform()) return 'unsupported';
  try {
    const status = await Camera.requestPermissions({ permissions: ['camera', 'photos'] });
    return combine([status.camera, status.photos]);
  } catch (error) {
    console.warn('[permissions] camera request failed', error);
    return 'unsupported';
  }
}

export async function notificationPermissionState(): Promise<PermissionState> {
  if (!Capacitor.isNativePlatform()) {
    // The web Notification API is a reasonable stand-in during development, so the
    // browser smoke test can exercise the same flow.
    if (typeof Notification === 'undefined') return 'unsupported';
    return normalize(Notification.permission);
  }
  try {
    const status = await LocalNotifications.checkPermissions();
    return normalize(status.display);
  } catch (error) {
    console.warn('[permissions] notification state unavailable', error);
    return 'unsupported';
  }
}

export async function requestNotificationPermission(): Promise<PermissionState> {
  if (!Capacitor.isNativePlatform()) {
    if (typeof Notification === 'undefined') return 'unsupported';
    try {
      return normalize(await Notification.requestPermission());
    } catch {
      return 'unsupported';
    }
  }
  try {
    const status = await LocalNotifications.requestPermissions();
    return normalize(status.display);
  } catch (error) {
    console.warn('[permissions] notification request failed', error);
    return 'unsupported';
  }
}

/** Android reports camera and library separately; the flow needs one answer. */
function combine(states: (string | undefined)[]): PermissionState {
  const values = states.map((state) => normalize(state));
  if (values.every((value) => value === 'granted')) return 'granted';
  if (values.some((value) => value === 'denied')) return 'denied';
  if (values.some((value) => value === 'prompt')) return 'prompt';
  return 'unsupported';
}

function normalize(state: string | undefined): PermissionState {
  switch (state) {
    case 'granted':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'prompt':
    case 'prompt-with-rationale':
      return 'prompt';
    default:
      return 'unsupported';
  }
}

// ------------------------------------------------------------------ scheduling

/**
 * Notification ids must be stable per reminder so a reschedule replaces rather than
 * duplicates, and they must fit in a 32-bit int. A hash of the reminder id gives
 * both, at the cost of a theoretical collision that `syncAll` would surface as one
 * reminder silently replacing another — acceptable for a handful of reminders, and
 * the alternative (storing an incrementing counter) needs its own storage.
 */
export function notificationIdFor(reminderId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < reminderId.length; index++) {
    hash ^= reminderId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  // Positive, and inside the range Android accepts.
  return (hash >>> 0) % 2147483647;
}

/** The body the OS shows, falling back to the title when nothing else is set. */
export function notificationBody(reminder: Reminder, fallback: string): string {
  return reminder.body.trim() === '' ? fallback : reminder.body.trim();
}

/**
 * Cancel everything this app scheduled.
 *
 * Used before a resync and when the user turns reminders off wholesale: the OS holds
 * the schedule, so "delete the reminder" is not enough — the pending notification has
 * to be withdrawn explicitly.
 */
export async function cancelAllScheduled(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length === 0) return;
    await LocalNotifications.cancel({ notifications: pending.notifications });
  } catch (error) {
    console.warn('[reminders] could not cancel pending notifications', error);
  }
}

export async function cancelScheduled(reminder: Reminder): Promise<void> {
  if (!Capacitor.isNativePlatform() || reminder.notificationId === null) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: reminder.notificationId }] });
  } catch (error) {
    console.warn('[reminders] could not cancel notification', error);
  }
}

export interface ScheduleOutcome {
  /** True when the OS accepted the schedule. */
  scheduled: boolean;
  /** Android will not repeat a daily alarm exactly without the exact-alarm grant. */
  notificationId: number | null;
}

/**
 * Hand one reminder to the operating system.
 *
 * The schedule is built from the reminder alone, so it is reproducible: same
 * reminder, same notification, whenever it is called.
 */
export async function scheduleReminder(reminder: Reminder): Promise<ScheduleOutcome> {
  if (!Capacitor.isNativePlatform()) return { scheduled: false, notificationId: null };
  if (!reminder.enabled) return { scheduled: false, notificationId: null };

  const [hour, minute] = reminder.time.split(':').map(Number);
  const id = notificationIdFor(reminder.id);
  const base = {
    id,
    title: reminder.title.trim() === '' ? 'FitAGI' : reminder.title.trim(),
    body: notificationBody(reminder, reminder.title),
    // Extra data so a future version can deep-link from the notification.
    extra: { reminderId: reminder.id, kind: reminder.kind },
    smallIcon: 'ic_stat_icon_config_sample',
  };

  try {
    // Always withdraw first: `schedule` on an existing id is not a replace on every
    // Android version, and a duplicate reminder is worse than a missed one.
    await LocalNotifications.cancel({ notifications: [{ id }] });

    if (reminder.weekdays.length === 0) {
      // Every day, repeating.
      await LocalNotifications.schedule({
        notifications: [
          {
            ...base,
            schedule: { on: { hour, minute }, repeats: true, allowWhileIdle: true },
          },
        ],
      });
    } else {
      // One weekly notification per selected weekday.
      await LocalNotifications.schedule({
        notifications: reminder.weekdays.map((weekday, index) => ({
          ...base,
          id: id + index,
          schedule: { on: { weekday: weekday + 1, hour, minute }, repeats: true, allowWhileIdle: true },
        })),
      });
    }
    return { scheduled: true, notificationId: id };
  } catch (error) {
    console.warn('[reminders] scheduling failed', error);
    return { scheduled: false, notificationId: null };
  }
}

/** Minutes until the next firing, or `null` when it never fires. */
export function minutesUntilNext(reminder: Reminder, now = new Date()): number | null {
  if (!reminder.enabled) return null;
  const target = minutesOfDay(reminder.time);
  const today = now.getDay();
  for (let offset = 0; offset < 8; offset++) {
    const weekday = (today + offset) % 7;
    if (reminder.weekdays.length > 0 && !reminder.weekdays.includes(weekday)) continue;
    const current = now.getHours() * 60 + now.getMinutes();
    if (offset === 0 && target <= current) continue;
    return offset * 24 * 60 + target - current;
  }
  return null;
}
