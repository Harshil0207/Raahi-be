const mongoose = require('mongoose');

/**
 * One document per configurable value, keyed by its dotted name.
 *
 * A row per setting rather than one big config document, because the admin UI
 * has to show who changed a particular value and when, and because two admins
 * editing different sections at the same time should not overwrite each other.
 */
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    group: { type: String, required: true, index: true },

    // Shape is enforced by the registry in config/settingsSchema.js before write.
    value: { type: mongoose.Schema.Types.Mixed, required: true },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Setting', settingSchema);
