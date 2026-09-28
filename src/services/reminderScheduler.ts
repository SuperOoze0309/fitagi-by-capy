import type { Reminder } from '../domain/types';
import { repositories } from '../repositories';
import {
  cancelAllScheduled,
  cancelScheduled,
  notificationPermissionState,
  scheduleReminder,
} from './reminders';

/**
 * Keeps the operating system's notification schedule in step with the stored
 * reminders.
 *
 * The OS owns the schedule and the app owns the list, so the two drift the moment
 * anything changes outside the editor: a restore from a backup, a permission granted
 * after the reminders were created, a reboot that dropped the alarms. `sync()`
 * rebuilds the whole schedule from storage, which is idempotent and therefore always
 * safe to call — on boot, after an edit, after an import, after a permission grant.
 */
export class ReminderScheduler {
  /**
   * Rebuild every scheduled notification from the stored list.
   *
   * Returns how many reminders the OS accepted, so the caller can tell "nothing to
   * do" from "the permission is missing".
   */
  async sync(): Promise<{ total: number; scheduled: number }> {
    const reminders = await repositories().reminders.all();
    const permission = await notificationPermissionState();

    if (permission !== 'granted') {
      // Nothing can be scheduled, and asking again from here would be a permission
      // prompt with no user gesture behind it. Leave the list alone.
      return { total: reminders.length, scheduled: 0 };
    }

    const enabled = reminders.filter((reminder) => reminder.enabled);

    // Clear first: a reminder that was deleted, disabled or retimed must not survive
    // as a pending notification. Re-adding costs one round trip each.
    await cancelAllScheduled();

    let scheduled = 0;
    for (const reminder of enabled) {
      const outcome = await scheduleReminder(reminder);
      if (!outcome.scheduled) continue;
      scheduled += 1;
      if (outcome.notificationId !== reminder.notificationId) {
        // Remember the id so a later edit can cancel exactly this notification.
        await repositories().reminders.save({
          ...reminder,
          notificationId: outcome.notificationId,
        });
      }
    }
    return { total: reminders.length, scheduled };
  }

  /** Schedule one reminder (after a save or a re-enable) and remember its id. */
  async schedule(reminder: Reminder): Promise<Reminder> {
    const permission = await notificationPermissionState();
    if (permission !== 'granted') return reminder;

    const outcome = await scheduleReminder(reminder);
    if (!outcome.scheduled) return reminder;
    if (outcome.notificationId === reminder.notificationId) return reminder;
    return repositories().reminders.save({ ...reminder, notificationId: outcome.notificationId });
  }

  /** Withdraw one reminder from the OS, e.g. before deleting or disabling it. */
  async cancel(reminder: Reminder): Promise<void> {
    await cancelScheduled(reminder);
  }
}

let instance: ReminderScheduler | null = null;

export function reminderScheduler(): ReminderScheduler {
  if (!instance) instance = new ReminderScheduler();
  return instance;
}
