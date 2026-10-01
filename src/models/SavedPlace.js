const mongoose = require('mongoose');

const savedPlaceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // 'home' and 'work' are the shortcuts the app surfaces first; anything else
    // is a custom place the user named themselves.
    label: { type: String, enum: ['home', 'work', 'custom'], default: 'custom' },
    name: { type: String, required: true, trim: true },

    address: { type: String, required: true, trim: true },
    placeId: { type: String, trim: true },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true } // [lng, lat]
    }
  },
  { timestamps: true }
);

// A user gets at most one home and one work; custom places are unlimited.
savedPlaceSchema.index(
  { userId: 1, label: 1 },
  { unique: true, partialFilterExpression: { label: { $in: ['home', 'work'] } } }
);

savedPlaceSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id,
    label: this.label,
    name: this.name,
    address: this.address,
    placeId: this.placeId,
    lat: this.location.coordinates[1],
    lng: this.location.coordinates[0],
    updatedAt: this.updatedAt
  };
};

module.exports = mongoose.model('SavedPlace', savedPlaceSchema);
