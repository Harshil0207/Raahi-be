class ApiError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
    this.expected = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, details) {
    return new ApiError(400, message, details);
  }

  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, message);
  }

  static forbidden(message = 'You are not allowed to do that') {
    return new ApiError(403, message);
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, message);
  }

  static conflict(message) {
    return new ApiError(409, message);
  }

  static tooManyRequests(message = 'Too many requests') {
    return new ApiError(429, message);
  }

  /**
   * Something upstream of us failed, not the caller.
   *
   * 502 rather than 500 so the distinction survives into the logs: a payment
   * gateway timing out is an operational fact about somebody else's service,
   * and reading it as our own bug sends whoever is on call to the wrong place.
   */
  static badGateway(message = 'An upstream service could not be reached') {
    return new ApiError(502, message);
  }

  /** A feature the deployment has not been configured for. */
  static notImplemented(message) {
    return new ApiError(501, message);
  }
}

module.exports = ApiError;
