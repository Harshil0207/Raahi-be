const crypto = require('crypto');

// Rejection sampling keeps the digits uniform; a plain modulo would bias the low ones.
function generateOtp(length = 4) {
  let otp = '';
  while (otp.length < length) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < 250) {
      otp += String(byte % 10);
    }
  }
  return otp;
}

module.exports = generateOtp;
