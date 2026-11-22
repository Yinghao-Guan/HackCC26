// Switches that change only after several frames in a row agree, so one bad frame
// cannot break a line or start one. Plain functions, no React.

export interface Switch {
  on: boolean;
  /** How many frames in a row have disagreed with `on`. */
  streak: number;
}

export const OFF: Switch = { on: false, streak: 0 };

/**
 * Update a switch with what one frame says. It turns on after `framesToTurnOn`
 * frames that say on, and off after `framesToTurnOff` frames that say off.
 */
export function stepSwitch(
  state: Switch,
  wantsOn: boolean,
  framesToTurnOn: number,
  framesToTurnOff: number,
): Switch {
  if (wantsOn === state.on) return { on: state.on, streak: 0 };
  const streak = state.streak + 1;
  const needed = wantsOn ? framesToTurnOn : framesToTurnOff;
  return streak >= needed ? { on: wantsOn, streak: 0 } : { on: state.on, streak };
}
