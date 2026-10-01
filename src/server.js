const http = require('http');
const app = require('./app');
const env = require('./config/env');
const logger = require('./utils/logger');
const { connectDatabase, disconnectDatabase } = require('./config/db');
const { initSocketServer } = require('./sockets');
const settings = require('./services/settings.service');
const chatService = require('./services/chat.service');
const gemini = require('./config/gemini');

const server = http.createServer(app);

async function start() {
  await connectDatabase();

  // Platform configuration is read on nearly every request, so it is seeded and
  // cached before the first one arrives.
  await settings.seed();

  initSocketServer(server);

  // Chats whose window elapsed while the process was down are closed on boot,
  // then swept periodically. Each is cheap: one indexed query over a small set.
  await chatService.sweepClosings().catch(() => {});
  setInterval(() => chatService.sweepClosings().catch(() => {}), 5 * 60 * 1000).unref();

  // Said once, at boot, so the assistant's two commonest failures — no key, and
  // a server older than the .env that holds it — are visible without a request.
  gemini.logStartupState();

  server.listen(env.port, () => {
    logger.info(`API listening on port ${env.port} (${env.nodeEnv})`);
  });
}

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);

  server.close(async () => {
    await disconnectDatabase();
    process.exit(0);
  });

  // Don't let a hung connection keep the process alive forever.
  setTimeout(() => process.exit(1), 10000).unref();
}

['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => shutdown(signal)));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

start().catch((err) => {
  logger.error('Failed to start server', err);
  process.exit(1);
});
