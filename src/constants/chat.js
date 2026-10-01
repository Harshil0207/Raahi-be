const CONVERSATION_STATUS = {
  OPEN: 'OPEN',
  // The ride is over but the configured grace window has not elapsed: history is
  // readable and messages can still be sent.
  CLOSING: 'CLOSING',
  // Read-only. History stays; nothing new can be added.
  CLOSED: 'CLOSED'
};

const MESSAGE_TYPE = {
  TEXT: 'TEXT',
  // Not sent by clients yet. SYSTEM is written by the server when a chat opens
  // or closes; the other two are here so the model does not need migrating when
  // they arrive.
  IMAGE: 'IMAGE',
  LOCATION: 'LOCATION',
  SYSTEM: 'SYSTEM'
};

const SENDABLE_TYPES = [MESSAGE_TYPE.TEXT];

const CHAT_EVENTS = {
  JOIN: 'chat:join',
  LEAVE: 'chat:leave',
  SEND: 'chat:message',
  NEW: 'chat:message:new',
  TYPING: 'chat:typing',
  READ: 'chat:read',
  CLOSED: 'chat:closed'
};

module.exports = { CONVERSATION_STATUS, MESSAGE_TYPE, SENDABLE_TYPES, CHAT_EVENTS };
