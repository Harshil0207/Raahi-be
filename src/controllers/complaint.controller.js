const complaintService = require('../services/complaint.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/response');

/** The reporter's side of a complaint — customers and riders both use these. */

const categories = asyncHandler(async (req, res) => {
  return ok(res, complaintService.availableCategories(req.user));
});

const create = asyncHandler(async (req, res) => {
  const complaint = await complaintService.create(req.user, req.body);
  return created(res, complaint, 'Complaint filed');
});

const list = asyncHandler(async (req, res) => {
  const result = await complaintService.listForReporter(req.user, req.query);
  return ok(res, result);
});

const detail = asyncHandler(async (req, res) => {
  const result = await complaintService.detailForReporter(req.params.complaintId, req.user);
  return ok(res, result);
});

const reply = asyncHandler(async (req, res) => {
  const message = await complaintService.replyAsReporter(req.params.complaintId, req.user, req.body.message);
  return created(res, message, 'Reply sent');
});

const unread = asyncHandler(async (req, res) => {
  return ok(res, await complaintService.unreadForReporter(req.user));
});

module.exports = { categories, create, list, detail, reply, unread };
