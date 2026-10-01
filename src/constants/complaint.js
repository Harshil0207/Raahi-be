const COMPLAINT_STATUS = {
  OPEN: 'OPEN',
  IN_REVIEW: 'IN_REVIEW',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  WAITING_FOR_RIDER: 'WAITING_FOR_RIDER',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED'
};

const COMPLAINT_PRIORITY = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  URGENT: 'URGENT'
};

/**
 * Which status may follow which.
 *
 * Complaints move around more than rides do — support puts one back to the
 * reporter, the reporter replies, it comes back into review — so the graph is
 * wider than the ride lifecycle. What it still rules out is reviving a closed
 * complaint or resolving one nobody looked at.
 */
const ALLOWED_TRANSITIONS = {
  [COMPLAINT_STATUS.OPEN]: [
    COMPLAINT_STATUS.IN_REVIEW,
    COMPLAINT_STATUS.WAITING_FOR_USER,
    COMPLAINT_STATUS.WAITING_FOR_RIDER,
    COMPLAINT_STATUS.CLOSED
  ],
  [COMPLAINT_STATUS.IN_REVIEW]: [
    COMPLAINT_STATUS.WAITING_FOR_USER,
    COMPLAINT_STATUS.WAITING_FOR_RIDER,
    COMPLAINT_STATUS.RESOLVED,
    COMPLAINT_STATUS.CLOSED
  ],
  [COMPLAINT_STATUS.WAITING_FOR_USER]: [
    COMPLAINT_STATUS.IN_REVIEW,
    COMPLAINT_STATUS.RESOLVED,
    COMPLAINT_STATUS.CLOSED
  ],
  [COMPLAINT_STATUS.WAITING_FOR_RIDER]: [
    COMPLAINT_STATUS.IN_REVIEW,
    COMPLAINT_STATUS.RESOLVED,
    COMPLAINT_STATUS.CLOSED
  ],
  // A resolution the reporter disputes goes back into review; otherwise it closes.
  [COMPLAINT_STATUS.RESOLVED]: [COMPLAINT_STATUS.IN_REVIEW, COMPLAINT_STATUS.CLOSED],
  [COMPLAINT_STATUS.CLOSED]: []
};

const OPEN_STATUSES = [
  COMPLAINT_STATUS.OPEN,
  COMPLAINT_STATUS.IN_REVIEW,
  COMPLAINT_STATUS.WAITING_FOR_USER,
  COMPLAINT_STATUS.WAITING_FOR_RIDER
];

const canTransition = (from, to) => (ALLOWED_TRANSITIONS[from] || []).includes(to);

const SLA_SETTING = {
  [COMPLAINT_PRIORITY.LOW]: 'support.slaHoursLow',
  [COMPLAINT_PRIORITY.MEDIUM]: 'support.slaHoursMedium',
  [COMPLAINT_PRIORITY.HIGH]: 'support.slaHoursHigh',
  [COMPLAINT_PRIORITY.URGENT]: 'support.slaHoursUrgent'
};

module.exports = {
  COMPLAINT_STATUS,
  COMPLAINT_PRIORITY,
  ALLOWED_TRANSITIONS,
  OPEN_STATUSES,
  canTransition,
  SLA_SETTING
};
