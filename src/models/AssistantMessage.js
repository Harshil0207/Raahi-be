const mongoose = require('mongoose');
const { MESSAGE_ROLE, MESSAGE_STATUS, LIMITS } = require('../constants/assistant');

/**
 * One turn in an assistant thread — either what the person asked or what the
 * model answered.
 *
 * The owner is denormalised onto every message. It costs two small fields and
 * it means reading a thread is one indexed query that already carries the
 * ownership check, rather than a lookup of the conversation followed by a
 * separate read that trusts it.
 *
 * What is NOT stored: anything sent to Google beyond the message text itself.
 * The system instruction and the account context are assembled per request and
 * deliberately not persisted, so a leaked database row cannot be replayed to
 * learn what the platform told the model about somebody.
 */
const assistantMessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssistantConversation',
      required: true,
      index: true
    },

    ownerType: { type: String, required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },

    role: { type: String, enum: Object.values(MESSAGE_ROLE), required: true },

    content: { type: String, required: true, maxlength: 20000 },

    status: {
      type: String,
      enum: Object.values(MESSAGE_STATUS),
      default: MESSAGE_STATUS.OK
    },

    /**
     * Usage, for watching the bill. Token counts are the model's own report and
     * are not shown to the person asking.
     */
    usage: {
      promptTokens: { type: Number, default: null },
      responseTokens: { type: Number, default: null },
      latencyMs: { type: Number, default: null }
    }
  },
  { timestamps: true }
);

// Reading a thread in order, scoped to its owner in the same index.
assistantMessageSchema.index({ conversationId: 1, createdAt: 1 });
assistantMessageSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });

/** The stored preview for the conversation list — one line, never a whole answer. */
assistantMessageSchema.statics.preview = function preview(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > LIMITS.PREVIEW_LENGTH ? `${flat.slice(0, LIMITS.PREVIEW_LENGTH - 1)}…` : flat;
};

module.exports = mongoose.model('AssistantMessage', assistantMessageSchema);
