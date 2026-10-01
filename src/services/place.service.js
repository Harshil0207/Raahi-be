const SavedPlace = require('../models/SavedPlace');
const ApiError = require('../utils/ApiError');

const MAX_CUSTOM_PLACES = 20;

const toDoc = ({ label, name, address, placeId, lat, lng }) => ({
  label,
  name,
  address,
  placeId,
  location: { type: 'Point', coordinates: [lng, lat] }
});

async function list(userId) {
  // Home and work first — they are the shortcuts the home screen shows.
  const places = await SavedPlace.find({ userId }).sort({ label: 1, updatedAt: -1 });
  const order = { home: 0, work: 1, custom: 2 };

  return places
    .sort((a, b) => order[a.label] - order[b.label])
    .map((place) => place.toPublic());
}

async function create(userId, payload) {
  if (payload.label === 'custom') {
    const count = await SavedPlace.countDocuments({ userId, label: 'custom' });
    if (count >= MAX_CUSTOM_PLACES) {
      throw ApiError.badRequest(`You can save up to ${MAX_CUSTOM_PLACES} custom places`);
    }
  } else {
    // Saving "home" again replaces the existing one rather than failing.
    const existing = await SavedPlace.findOne({ userId, label: payload.label });
    if (existing) return update(userId, existing._id, payload);
  }

  const place = await SavedPlace.create({ userId, ...toDoc(payload) });
  return place.toPublic();
}

async function update(userId, id, payload) {
  const place = await SavedPlace.findOneAndUpdate({ _id: id, userId }, toDoc(payload), {
    new: true,
    runValidators: true
  });
  if (!place) throw ApiError.notFound('Saved place not found');
  return place.toPublic();
}

async function remove(userId, id) {
  const place = await SavedPlace.findOneAndDelete({ _id: id, userId });
  if (!place) throw ApiError.notFound('Saved place not found');
  return { id };
}

module.exports = { list, create, update, remove };
