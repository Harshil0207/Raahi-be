const { PaymentProvider } = require('./provider');
const ApiError = require('../../utils/ApiError');

/**
 * No gateway connected.
 *
 * This is the default, and it is not a placeholder that pretends: every call
 * refuses with a 501 saying plainly that UPI is not wired up, so a platform
 * that has not finished its payment integration collects cash and knows it,
 * rather than marking rides paid that nobody paid for.
 *
 * Refusing loudly here is what makes `payment.upiEnabled` safe to leave off by
 * default and what the settings consistency check leans on: turning UPI on
 * without choosing a provider is caught at the moment an admin tries it.
 */
class NoneProvider extends PaymentProvider {
  constructor() {
    super({ id: 'none', label: 'No gateway connected', isProduction: false });
  }

  get available() {
    return false;
  }

  get unavailableReason() {
    return 'No payment gateway is configured, so UPI cannot be collected.';
  }

  async createPayment() {
    throw new ApiError(501, this.unavailableReason);
  }

  async generateQrCode() {
    throw new ApiError(501, this.unavailableReason);
  }

  async verifyPayment() {
    throw new ApiError(501, this.unavailableReason);
  }
}

module.exports = NoneProvider;
