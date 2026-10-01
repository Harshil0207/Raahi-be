const mongoose = require('mongoose');

// Last known device location per user. Riders also keep an authoritative copy on
// the Rider document (that is what matching queries); this collection exists so a
// customer's device location can be stored and read back for pickup defaults.
const locationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true
    },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true } // [lng, lat]
    },
    accuracy: { type: Number },
    heading: { type: Number },
    speed: { type: Number },
    recordedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

locationSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Location', locationSchema);
