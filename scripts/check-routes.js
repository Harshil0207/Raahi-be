/**
 * Checks that every API call the two frontends make hits a route this server
 * actually mounts.
 *
 * This exists because it is the one class of mistake nothing else catches. Lint
 * sees a valid string. The build sees a valid string. A frontend driven against
 * a mock sees whatever the mock was written to answer — and a mock is usually
 * written by reading the frontend, so the two agree with each other and both
 * disagree with the server. The first sign is a 404 in production.
 *
 * It walks the real Express router rather than a list of paths kept by hand, so
 * it cannot drift.
 *
 *   node scripts/check-routes.js
 *   npm run check:routes
 *
 * Exits non-zero if a call has no matching route.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');

// The config module insists on a database URL and JWT secrets. Nothing here
// connects to anything; these are only to get the module loaded.
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/raahi-routes';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'route-check-access-secret-long-enough';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'route-check-refresh-secret-long-enough';

const app = require('../src/app');

const API_PREFIX = '/api/v1';

// ------------------------------------------------------------ what is mounted

function walk(stack, prefix) {
  const routes = [];

  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      }
      continue;
    }

    if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      // Recover the mount path from the layer's regexp. Express does not keep
      // it anywhere friendlier.
      const mount = layer.regexp.source
        .replace('^\\/', '/')
        .replace('\\/?(?=\\/|$)', '')
        .replace(/\\\//g, '/')
        .replace(/\^|\$|\?|\(|\)|\[|\]|\+/g, '');

      routes.push(...walk(layer.handle.stack, prefix + (mount === '/' ? '' : mount)));
    }
  }

  return routes;
}

const mounted = walk(app._router.stack, '');

// ------------------------------------------------------------- what is called

// The frontends normally sit inside the project; a checkout that keeps them
// beside it instead still works.
const root = path.join(__dirname, '..');

const locate = (...segments) =>
  [path.join(root, ...segments), path.join(root, '..', ...segments)].find((dir) => fs.existsSync(dir));

/**
 * The console lives inside the customer app now, at `client/src/admin`, so its
 * API layer is no longer a sibling folder to discover. Listing it explicitly
 * keeps both halves checked: without this entry the fifty-odd admin calls
 * simply stopped being compared against the routes they hit, and a renamed
 * admin endpoint would have gone unnoticed.
 */
const APPS = [
  { name: 'client', dir: locate('client', 'src', 'services') },
  { name: 'admin', dir: locate('client', 'src', 'admin', 'services') }
];

// `api.get('/rides/' + id)` and friends. A template placeholder becomes a
// wildcard, since what matters is the shape, not the value.
const CALL = /api\.(get|post|patch|put|delete)\(\s*(`[^`]+`|'[^']+')/g;

function callsIn(dir) {
  if (!dir || !fs.existsSync(dir)) return [];

  const calls = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js') || file === 'api.js') continue;

    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(CALL)) {
      const raw = match[2].slice(1, -1);
      // A call built from a variable cannot be checked; skip it rather than
      // report a false problem.
      if (raw.startsWith('${')) continue;

      calls.push({
        method: match[1].toUpperCase(),
        path: raw.replace(/\$\{[^}]+\}/g, ':param').split('?')[0],
        file
      });
    }
  }
  return calls;
}

// ------------------------------------------------------------------ comparison

const segments = (p) => p.split('/').filter(Boolean);

function matches(call, route) {
  if (call.method !== route.method) return false;

  const wanted = segments(call.path);
  // The frontends' base URL already carries the prefix, so strip it from the
  // mounted path before comparing.
  const have = segments(route.path.startsWith(API_PREFIX) ? route.path.slice(API_PREFIX.length) : route.path);

  if (wanted.length !== have.length) return false;
  return have.every((part, i) => part.startsWith(':') || part === wanted[i]);
}

let problems = 0;
let checked = 0;

for (const { name, dir } of APPS) {
  if (!dir) {
    console.log(`${name}: not present, skipped`);
    continue;
  }

  const calls = callsIn(dir);
  checked += calls.length;

  const unmatched = calls.filter((call) => !mounted.some((route) => matches(call, route)));

  if (unmatched.length) {
    problems += unmatched.length;
    console.error(`\n${name}: ${unmatched.length} call(s) with no matching route`);
    for (const call of unmatched) {
      console.error(`  ${call.method} ${call.path}   (${name}/src/services/${call.file})`);
    }
  } else {
    console.log(`${name}: ${calls.length} calls, all matched`);
  }
}

console.log(`\n${mounted.length} routes mounted, ${checked} calls checked`);

if (problems) {
  console.error(`\n${problems} call(s) would 404. Fix the path on one side or the other.`);
  process.exit(1);
}
