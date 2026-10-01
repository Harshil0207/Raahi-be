/**
 * Exercises whichever map provider the current .env selects, so a key change or
 * a provider outage shows up here rather than halfway through a booking.
 *
 *   npm run maps:check
 *   npm run maps:check -- "Connaught Place Delhi"
 */
require('../src/config/env');

const maps = require('../src/services/maps.service');

const query = process.argv[2] || 'Andheri Station Mumbai';
const FROM = { lat: 19.1197, lng: 72.8464 };
const TO = { lat: 19.0662, lng: 72.8687 };

const line = (label, value) => console.log(`  ${label.padEnd(18)} ${value}`);

(async () => {
  console.log(`\nProvider in use: ${maps.providerName}\n`);

  console.log(`search "${query}"`);
  let first;
  try {
    const results = await maps.searchPlaces(query, FROM);
    first = results[0];
    line('results', results.length);
    if (first) {
      line('top match', first.description);
      line('coordinates', first.lat != null ? `${first.lat}, ${first.lng}` : '(needs geocode)');
      line('placeId', first.placeId);
    }
  } catch (err) {
    line('FAILED', `${err.status || ''} ${err.message}`);
  }

  console.log('\ngeocode');
  try {
    const target = first?.placeId ? { placeId: first.placeId } : { address: query };
    const geo = await maps.geocode(target);
    line('address', geo.address);
    line('coordinates', `${geo.lat}, ${geo.lng}`);
  } catch (err) {
    line('FAILED', `${err.status || ''} ${err.message}`);
  }

  console.log('\nreverse geocode (pin drop)');
  try {
    const geo = await maps.geocode(FROM);
    line('address', geo.address);
  } catch (err) {
    line('FAILED', `${err.status || ''} ${err.message}`);
  }

  console.log('\nroute');
  const route = await maps.getRoute(FROM, TO);
  line('distance', `${route.distanceKm.toFixed(2)} km`);
  line('duration', route.durationMin != null ? `${route.durationMin} min` : 'n/a');
  line('source', route.source);
  line('geometry', route.polyline ? `${route.polyline.length} chars` : 'none');

  if (route.source === 'haversine') {
    console.log('\n  Route came from the straight-line fallback, not the provider.');
    console.log('  Fares will be slightly under real road distance until this is fixed.');
  }

  console.log('');
  process.exit(0);
})();
