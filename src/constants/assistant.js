/**
 * The AI assistant.
 *
 * Named `assistant` rather than `chat` on purpose: `chat` is already the
 * conversation between a customer and their rider during a trip, and folding a
 * support bot into it would mean one collection, one socket room and one set of
 * permissions doing two unrelated jobs. They stay apart.
 */

/**
 * Who is asking. This is derived from the verified token on every request and
 * is never read from the request body — see `assistant.controller.js`. It picks
 * the system instruction and it picks what account context may be gathered, so
 * letting a client set it would be letting a client grant itself an audience.
 */
const ASSISTANT_ROLE = {
  CUSTOMER: 'CUSTOMER',
  RIDER: 'RIDER',
  ADMIN: 'ADMIN'
};

/** Which table the conversation's owner lives in. Admins are not Users here. */
const OWNER_TYPE = {
  USER: 'USER',
  ADMIN: 'ADMIN'
};

const MESSAGE_ROLE = {
  USER: 'user',
  ASSISTANT: 'assistant'
};

/** Why an assistant turn ended, for the UI and for support. */
const MESSAGE_STATUS = {
  OK: 'OK',
  // The model produced nothing usable — blocked, empty, or cut off.
  EMPTY: 'EMPTY',
  FAILED: 'FAILED'
};

const LIMITS = {
  /** One question. Long enough for a real complaint, short enough to bound cost. */
  MAX_MESSAGE_LENGTH: 2000,
  /**
   * How much of the thread is replayed to the model.
   *
   * Every turn resends the history, so this is the single knob that decides
   * what a long conversation costs. Twenty turns is more than enough context
   * for a support question and keeps the bill flat.
   */
  HISTORY_TURNS: 20,
  /** A conversation past this is closed off and a new one started. */
  MAX_MESSAGES_PER_CONVERSATION: 200,
  /** How many threads the list endpoint returns. */
  MAX_CONVERSATIONS: 30,
  /** Trimmed preview stored on the conversation for the list view. */
  PREVIEW_LENGTH: 120
};

/**
 * The suggested questions shown on an empty thread.
 *
 * Chosen by the server from the verified role rather than by the client, for
 * the same reason the system instruction is: what a rider is offered and what
 * an admin is offered differ, and the browser is not the place that decision is
 * made. They are ordinary questions — tapping one sends the text through the
 * same endpoint as typing it, with no privileged path of any kind.
 */
const QUICK_ACTIONS = {
  [ASSISTANT_ROLE.CUSTOMER]: [
    { label: 'Book a ride', message: 'How do I book a ride?' },
    { label: 'Why did my ride expire?', message: 'Why did my ride request expire, and what can I do now?' },
    { label: 'Ride payment', message: 'How do I pay for my ride?' },
    { label: 'Report a problem', message: 'I have a problem with a ride. How do I report it?' }
  ],
  [ASSISTANT_ROLE.RIDER]: [
    { label: "Why can't I go online?", message: "Why can't I go online right now?" },
    { label: 'Check earnings', message: 'How are my earnings worked out?' },
    { label: 'Wallet help', message: 'How does my wallet balance and recharge work?' },
    { label: 'Report a problem', message: 'I have a problem and need help. How do I report it?' }
  ],
  [ASSISTANT_ROLE.ADMIN]: [
    { label: 'Pricing settings', message: 'Where do I change pricing, and what does each setting affect?' },
    { label: 'Rider management', message: 'What can I do in the rider management section?' },
    { label: 'Customer complaints', message: 'How does the complaint system work, and what are the SLA rules?' },
    { label: 'Platform settings', message: 'Which platform settings exist and which ones are high impact?' }
  ]
};

module.exports = {
  ASSISTANT_ROLE,
  QUICK_ACTIONS,
  ALL_ASSISTANT_ROLES: Object.values(ASSISTANT_ROLE),
  OWNER_TYPE,
  MESSAGE_ROLE,
  ALL_MESSAGE_ROLES: Object.values(MESSAGE_ROLE),
  MESSAGE_STATUS,
  LIMITS
};
