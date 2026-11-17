// The Tasks Herdr chrome's control metrics, shared by the Backlog pill and the panel's tool bar
// buttons so the two read as one family and change together.

/**
 * A pill or tool bar control: its height, horizontal padding, the gap between icon and label, its
 * radius, its icon's size and its label's text size.
 */
export const CONTROL = {
  height: 26,
  paddingX: 8,
  gap: 5,
  radius: 6,
  iconSize: 14,
  textSize: 12,
} as const;
