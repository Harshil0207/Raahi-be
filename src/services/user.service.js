const User = require('../models/User');
const ApiError = require('../utils/ApiError');

async function updateProfile(userId, updates) {
  if (updates.email || updates.phone) {
    const clash = await User.findOne({
      _id: { $ne: userId },
      $or: [updates.email && { email: updates.email }, updates.phone && { phone: updates.phone }].filter(
        Boolean
      )
    });
    if (clash) throw ApiError.conflict('Email or phone is already in use by another account');
  }

  const user = await User.findByIdAndUpdate(userId, updates, { new: true, runValidators: true });
  if (!user) throw ApiError.notFound('User not found');

  return user.toPublic();
}

module.exports = { updateProfile };
