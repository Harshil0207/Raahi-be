const mongoose = require('mongoose');
const { ASSISTANT_ROLE, OWNER_TYPE, LIMITS } = require('../constants/assistant');

/**
 * One thread with the AI assistant.
 *
 * Owned by exactly one account. `ownerType` is part of the identity rather than
 * inferred, because an admin is a row in `Admin` and a customer is a row in
 * `User` — the two id spaces are separate, and two documents could otherwise
 * collide on id alone.
 *
 * Every query in the service filters on `{ ownerType, ownerId }`, so there is
 * no path by which one account reads another's thread. There is deliberately no
 * admin endpoint that reads somebody else's conversation: a private exchange
 * with a support assistant is not operations data.
 *
 * The messages live in their own collection rather than in an array here. That
 * follows the ride chat, and it means a long thread does not grow one document
 * without bound, and the list view can be served without loading any message
 * bodies at all.
 */
const assistantConversationSchema = new mongoose.Schema(
  {
    ownerType: { type: String, enum: Object.values(OWNER_TYPE), required: true },
    // Intentionally unreferenced: the collection it points at depends on
    // `ownerType`, so a single `ref` would be wrong half the time.
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /**
     * The role at the time the thread was opened, kept so the list view can
     * label it. It is NOT what authorises anything — the role used on each turn
     * is re-derived from that request's token, so an account whose role changed
     * cannot keep an old audience by reusing an old conversation.
     */
    role: { type: String, enum: Object.values(ASSISTANT_ROLE), required: true },

    title: { type: String, default: null, maxlength: 120 },

    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: null, maxlength: LIMITS.PREVIEW_LENGTH + 1 },
    messageCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

// The list view: this account's threads, newest first.
assistantConversationSchema.index({ ownerType: 1, ownerId: 1, lastMessageAt: -1 });

module.exports = mongoose.model('AssistantConversation', assistantConversationSchema);
