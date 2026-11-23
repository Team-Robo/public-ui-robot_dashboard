// action_msgs/msg/GoalStatus codes.
export const GOAL_STATUS_LABELS: Record<number, string> = {
  0: 'unknown',
  1: 'accepted',
  2: 'executing',
  3: 'canceling',
  4: 'succeeded',
  5: 'canceled',
  6: 'aborted',
}

export function goalStatusLabel(status: number): string {
  return GOAL_STATUS_LABELS[status] ?? `status ${status}`
}

// Full UUIDs are 16 bytes, all sent over the wire, but only the first few
// are needed to tell goals apart at a glance in the UI.
export function shortGoalId(uuid: number[]): string {
  return uuid
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
