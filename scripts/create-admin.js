/**
 * Creates the first super admin.
 *
 * There is a chicken-and-egg problem with admin management: only a super admin
 * can create admins, so the first one has to come from outside the API. This
 * script is that door, and it is deliberately a manual step run by whoever has
 * shell access — not a seeded default account with a known password.
 *
 * Usage:
 *   node scripts/create-admin.js "Name" email@example.com 'TheirPassword1'
 *
 * or set ADMIN_SEED_NAME / ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD and run it
 * with no arguments. Running it again for an existing email updates that
 * admin's password and role rather than failing, which is also the way back in
 * if the last super admin password is lost.
 */
const mongoose = require('mongoose');
const env = require('../src/config/env');
const Admin = require('../src/models/Admin');
const settings = require('../src/services/settings.service');
const { ADMIN_ROLES } = require('../src/constants/adminRoles');

const [, , argName, argEmail, argPassword] = process.argv;

const name = argName || env.admin.seedName;
const email = (argEmail || env.admin.seedEmail || '').trim().toLowerCase();
const password = argPassword || env.admin.seedPassword;

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main() {
  if (!email) fail('An email is required: node scripts/create-admin.js "Name" email@example.com \'Password1\'');
  if (!password) fail('A password is required.');
  if (password.length < 10) fail('Use a password of at least 10 characters.');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    fail('The password needs an uppercase letter, a lowercase letter and a number.');
  }

  await mongoose.connect(env.mongoUri);

  // Seeding settings here too, so a fresh database is usable straight after this.
  const seeded = await settings.seed();

  const existing = await Admin.findOne({ email }).select('+password');

  if (existing) {
    existing.name = name;
    existing.password = password;
    existing.role = ADMIN_ROLES.SUPER_ADMIN;
    existing.isActive = true;
    // Ends any session that was open under the old password.
    existing.tokenVersion += 1;
    await existing.save();

    console.log(`\n  Updated the existing admin ${email} — super admin, new password, sessions ended.`);
  } else {
    await Admin.create({ name, email, password, role: ADMIN_ROLES.SUPER_ADMIN });
    console.log(`\n  Created super admin ${email}.`);
  }

  if (seeded.length) console.log(`  Seeded ${seeded.length} platform setting(s).`);
  console.log(`  Sign in at ${env.admin.url}\n`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(`\n  Failed: ${err.message}\n`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
