const { GoogleGenAI } = require('@google/genai');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * The one place this process talks to Google.
 *
 * Everything secret about the assistant is here, which means it is in the
 * environment and nowhere else. No route returns the key, no model stores it,
 * and the frontend has no path to it at all: the browser calls our own API and
 * this process makes the outbound call.
 *
 * The client is built once and reused. Constructing it per request would open a
 * fresh connection pool for every question asked.
 */

let client = null;

/** Whether an assistant request can be attempted at all. */
function isConfigured() {
  return Boolean(env.gemini.apiKey);
}

function getClient() {
  if (!isConfigured()) return null;

  if (!client) {
    client = new GoogleGenAI({
      apiKey: env.gemini.apiKey,
      // Only set in tests, where a local server stands in for Google's
      // endpoint. Empty in every real deployment, which is when the SDK uses
      // its own default.
      ...(env.gemini.baseUrl ? { httpOptions: { baseUrl: env.gemini.baseUrl } } : {})
    });

    logger.info(`Gemini client ready (model: ${env.gemini.model})`);
  }

  return client;
}

/**
 * Reset between tests, where the base URL changes and a cached client would
 * keep pointing at the previous one.
 */
function resetClient() {
  client = null;
}

/**
 * One line at boot saying whether the assistant can work at all.
 *
 * The key itself is NEVER printed — only whether one was found. Two of the
 * three ways this integration fails are visible from this line alone: a key
 * that is not in `.env`, and a server still running from before `.env` changed.
 * The third is the model, which is printed beside it so a retired one can be
 * recognised without reading the code.
 */
function logStartupState() {
  logger.info(`Gemini API key loaded: ${isConfigured()}`);

  if (isConfigured()) {
    logger.info(`Gemini model: ${env.gemini.model}`);
    if (/-latest$/.test(env.gemini.model)) {
      logger.warn(
        `Gemini model "${env.gemini.model}" is a moving alias. Google retires the model behind an ` +
          'alias without repointing it, which surfaces as a 404 on every request. Pin a version instead.'
      );
    }
  } else {
    logger.warn(
      'The AI assistant is switched off: GEMINI_API_KEY is not set in .env. ' +
        'Add it and restart — the value is read once, at startup.'
    );
  }
}

/**
 * What may safely be told to a caller about the assistant's availability.
 *
 * Deliberately does not include the key, its length, or whether a particular
 * model exists — only whether asking a question is worth attempting.
 */
function describe() {
  return {
    available: isConfigured(),
    model: isConfigured() ? env.gemini.model : null
  };
}

module.exports = { getClient, isConfigured, resetClient, describe, logStartupState };
