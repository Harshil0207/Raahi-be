#!/usr/bin/env node
/**
 * Talk to Gemini directly, with the real key, and print exactly what comes back.
 *
 * This is the first thing to run when the assistant is not answering. It takes
 * the application out of the picture entirely — no HTTP, no authentication, no
 * conversation storage — so whatever it prints is about Gemini and nothing
 * else. If this works and the chatbot does not, the fault is downstream of here.
 *
 *   node scripts/assistant-check.js --list      which models this key can use
 *   node scripts/assistant-check.js             ask a customer question
 *   node scripts/assistant-check.js rider "Why can't I go online?"
 *
 * The database is optional. It is used to build the prompt from live settings,
 * because a wrong price in an answer is a real defect — but if it cannot be
 * reached, the check carries on with the registry defaults and says so. A Mongo
 * problem must never look like a Gemini problem.
 *
 * The API key is never printed, here or anywhere else.
 */
const mongoose = require('mongoose');
const env = require('../src/config/env');
const gemini = require('../src/config/gemini');
const settings = require('../src/services/settings.service');
const prompt = require('../src/services/assistant/prompt');
const { ASSISTANT_ROLE } = require('../src/constants/assistant');

const ROLE_ARG = {
  customer: ASSISTANT_ROLE.CUSTOMER,
  rider: ASSISTANT_ROLE.RIDER,
  admin: ASSISTANT_ROLE.ADMIN
};

const line = () => console.log('─'.repeat(64));

function requireKey() {
  console.log(`Gemini API key loaded: ${gemini.isConfigured()}`);

  if (gemini.isConfigured()) return;

  console.error('\nGEMINI_API_KEY is not set, so there is nothing to check.');
  console.error('Put it in .env at the project root:');
  console.error('  GEMINI_API_KEY=...');
  console.error('\nA key from https://aistudio.google.com/apikey. It is read once, at startup,');
  console.error('so the server has to be restarted after the file changes.\n');
  process.exit(1);
}

/**
 * Every model this key may call.
 *
 * The answer to "is my model name valid" is not in any documentation — it is
 * whatever this returns, for this key, today. A name that worked last month can
 * be gone: Google retires models, and an alias pointing at a retired one is
 * never repointed. It just starts answering 404.
 */
async function listModels() {
  requireKey();
  console.log(`\nAsking Google which models this key can use…\n`);

  const rows = [];
  for await (const model of await gemini.getClient().models.list()) {
    const name = String(model?.name || '').replace(/^models\//, '');
    if (!name) continue;
    const methods = model?.supportedActions || model?.supportedGenerationMethods || [];
    rows.push({ name, generate: !methods.length || methods.includes('generateContent') });
  }

  const usable = rows.filter((r) => r.generate).map((r) => r.name);

  line();
  if (!usable.length) {
    console.log('This key returned no models that support generateContent.');
  } else {
    for (const name of usable) {
      console.log(`  ${name}${name === env.gemini.model ? '   <- GEMINI_MODEL is set to this' : ''}`);
    }
  }
  line();

  const configured = env.gemini.model;
  if (usable.includes(configured)) {
    console.log(`\n"${configured}" is available. The model is not your problem.\n`);
  } else {
    console.log(`\n"${configured}" is NOT in that list, which is why every request fails with 404.`);
    console.log(`Set GEMINI_MODEL in .env to one of the names above, then restart.\n`);
    process.exitCode = 1;
  }
}

/** Live settings if the database is reachable; registry defaults if not. */
async function loadSettings() {
  try {
    await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 4000 });
    await settings.init();
    return true;
  } catch (err) {
    console.log(`(MongoDB unreachable — ${err.message.split('\n')[0]})`);
    console.log('(carrying on with the built-in defaults; the prices below may not be yours)\n');
    return false;
  }
}

async function ask() {
  requireKey();

  const role = ROLE_ARG[(process.argv[2] || 'customer').toLowerCase()] || ASSISTANT_ROLE.CUSTOMER;
  const question = process.argv.slice(3).join(' ') || 'How much does a bike ride cost per kilometre?';

  const live = await loadSettings();

  const systemInstruction = prompt.build({
    role,
    name: 'Test',
    context: 'This is a configuration check. No account details are available.'
  });

  console.log(`Model:    ${env.gemini.model}`);
  console.log(`Role:     ${role}`);
  console.log(`Question: ${question}`);
  console.log(`\nSystem instruction is ${systemInstruction.length} characters. Asking Gemini…\n`);

  const startedAt = Date.now();

  const response = await gemini.getClient().models.generateContent({
    model: env.gemini.model,
    contents: [{ role: 'user', parts: [{ text: question }] }],
    config: {
      systemInstruction,
      maxOutputTokens: env.gemini.maxOutputTokens,
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(env.gemini.timeoutMs)
    }
  });

  const text = (response.text || '').trim();

  line();
  console.log(text || `(no text — ${response.candidates?.[0]?.finishReason || 'unknown reason'})`);
  line();
  console.log(
    `\n${Date.now() - startedAt}ms · ${response.usageMetadata?.promptTokenCount ?? '?'} prompt tokens · ` +
      `${response.usageMetadata?.candidatesTokenCount ?? '?'} response tokens`
  );

  if (live) {
    // The point of the check: the figure in the answer should be the figure in
    // the database, so a changed setting shows here without a redeploy.
    console.log(
      `\nThe live setting right now: bike is ${settings.get('fare.currency')} ` +
        `${settings.get('services.BIKE.ratePerKm')} per km, commission ` +
        `${settings.get('finance.platformCommissionPercent')}%.`
    );
    console.log('If the answer disagrees with that line, the prompt is not reading live settings.\n');
  } else {
    console.log('');
  }
}

const main = process.argv.includes('--list') ? listModels : ask;

main()
  .catch((err) => {
    const status = err?.status ?? err?.code;

    console.error(`\nFAILED — status ${status ?? 'none'}: ${err.message}`);

    if (status === 404) {
      console.error(
        `\nThe model "${env.gemini.model}" does not exist for this key.\n` +
          'This is what a retired model looks like. Run:\n' +
          '  node scripts/assistant-check.js --list\n' +
          'and set GEMINI_MODEL in .env to a name it prints.'
      );
    }

    if (status === 401 || status === 403) {
      console.error(
        '\nGoogle rejected the key. Check that GEMINI_API_KEY is the whole value with no quotes,\n' +
          'that it is enabled for the Generative Language API, and that the server was restarted.'
      );
    }

    if (status === 429) {
      console.error('\nThe key is over its quota. Wait, or use a key with more headroom.');
    }

    if (!status) {
      console.error(
        '\nNo HTTP status, so the request probably never reached Google. Check the network,\n' +
          'a proxy, or a firewall between this machine and generativelanguage.googleapis.com.'
      );
    }

    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
