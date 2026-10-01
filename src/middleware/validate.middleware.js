const ApiError = require('../utils/ApiError');

// validate({ body, query, params }) — each entry is a Zod schema.
// Parsed output replaces the raw input so controllers get coerced, trimmed values.
const validate = (schemas) => (req, res, next) => {
  for (const key of ['body', 'query', 'params']) {
    const schema = schemas[key];
    if (!schema) continue;

    const result = schema.safeParse(req[key]);
    if (!result.success) {
      const fields = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || key,
        message: issue.message
      }));
      return next(ApiError.badRequest('Validation failed', fields));
    }

    if (key === 'query') {
      // req.query is a getter on newer Express versions, so mutate in place.
      Object.keys(req.query).forEach((k) => delete req.query[k]);
      Object.assign(req.query, result.data);
    } else {
      req[key] = result.data;
    }
  }

  next();
};

module.exports = { validate };
