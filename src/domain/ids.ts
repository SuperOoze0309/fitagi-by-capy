/**
 * ID generation. No `uuid` dependency: we only need local uniqueness, and a
 * time-ordered prefix keeps records naturally sortable.
 */

let counter = 0;

export function newId(prefix: string): string {
  counter = (counter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  const seq = counter.toString(36).padStart(3, '0');
  return `${prefix}_${time}${seq}${rand}`;
}

export const newWorkoutId = () => newId('w');
export const newExerciseEntryId = () => newId('e');
export const newSetId = () => newId('s');
export const newRuleId = () => newId('r');
export const newSummaryId = () => newId('sum');
