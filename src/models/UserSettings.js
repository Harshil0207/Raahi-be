const mongoose = require('mongoose');

/**
 * One person's own preferences. One document per user.
 *
 * `values` is a flat map of registry key to stored value — `{'appearance.theme':
 * 'dark'}` — and it is deliberately a Mixed map rather than a field per setting.
 * The reason is that the registry in `config/userSettingsSchema.js` is already
 * the thing that says what may be stored and what shape it takes, and a second
 * declaration here would be a second thing to keep in step. Every write passes
 * through that registry; nothing reaches this document unvalidated.
 *
 * What this is NOT is an unstructured blob. The document holds only keys the
 * registry declares, the API reads and writes by group, and a key that is
 * dropped from the registry stops being served whether or not a row for it
 * lingers here.
 *
 * ONLY WHAT WAS CHOSEN IS STORED. A setting left alone has no entry at all, and
 * its value comes from the registry at read time. So a default can be changed
 * in a release and everyone who never touched that setting moves with it, while
 * anybody who did keeps their choice. It also means a new user needs no
 * document, no seeding step, and no migration when a setting is added.
 */
const userSettingsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      // Unique rather than merely indexed: two settings documents for one
      // person is the kind of bug where the app reads one and writes the other,
      // and the symptom is a setting that will not stay changed.
      unique: true
    },

    values: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map()
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserSettings', userSettingsSchema);
