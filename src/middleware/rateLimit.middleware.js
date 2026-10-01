const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const message = (text) => ({ success: false, message: text });

const baseOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  // Rate limiting gets in the way of local development and tests.
  skip: () => !env.isProduction
};

const apiLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000,
  limit: 120,
  message: message('Too many requests, please slow down')
});

const authLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: message('Too many authentication attempts, try again later')
});

const otpLimiter = rateLimit({
  ...baseOptions,
  windowMs: 10 * 60 * 1000,
  limit: 15,
  message: message('Too many OTP attempts, try again later')
});

/**
 * Admin sign-in. Tighter than the customer limiter: there are few admin
 * accounts, each one is valuable, and nobody legitimately signs in ten times.
 */
const adminAuthLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: message('Too many sign-in attempts, try again later')
});

/**
 * Admin mutations. An operations console makes a lot of reads and few writes, so
 * this sits on the writing routes only and is generous enough not to interrupt
 * real work while still ruling out a script.
 */
const adminWriteLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000,
  limit: 60,
  message: message('Too many changes at once, please slow down')
});

/**
 * The AI assistant.
 *
 * The one limiter that stays on outside production, because every question is a
 * paid call to Google and a runaway client in development spends the same money
 * a runaway client in production does.
 *
 * Keyed on the account rather than the IP: a household, an office or a phone
 * network puts many people behind one address, and an IP key would let one
 * person's questions lock out everyone around them. Every route it guards is
 * authenticated, so there is always an account to key on.
 */
const assistantLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60 * 1000,
  // Far above the pace of somebody typing questions, and far below the pace of
  // a script.
  limit: 20,
  keyGenerator: (req) => String(req.admin?._id || req.user?._id || req.ip),
  message: message('You are asking a lot of questions at once. Give it a moment and try again.')
});

// Riders push location frequently while online; this only catches runaway clients.
const locationLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000,
  limit: 240,
  message: message('Location updates are being sent too frequently')
});

module.exports = {
  apiLimiter,
  authLimiter,
  otpLimiter,
  locationLimiter,
  adminAuthLimiter,
  adminWriteLimiter,
  assistantLimiter
};
