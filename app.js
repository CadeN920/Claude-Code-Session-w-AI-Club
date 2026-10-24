// Wanderlog — a tiny travel tracker. All data lives in localStorage.

const STORAGE_KEY = 'wanderlog-v1';
const DAY = 24 * 60 * 60 * 1000;

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);
const toISO = (d) => d.toISOString().slice(0, 10);
const parseDate = (s) => new Date(s + 'T00:00:00');
const today = () => parseDate(toISO(new Date()));
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / DAY);
const fmtDate = (s) =>
  parseDate(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function escapeHTML(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Great-circle distance in km
function haversine(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Rough guess so the region field is usually right; it can always be changed.
function guessContinent(lat, lng) {
  const crete = lat > 34.8 && lng > 23;
  if (lat < 35.8 && lng > -18 && lng < 32 && !crete) return 'Africa';
  return lng > 29 ? 'Asia' : 'Europe';
}

// ---------- state ----------

function defaultState() {
  const start = today();
  return {
    trip: { name: 'My Trip', start: toISO(start), end: toISO(addDays(start, 137)), home: null },
    stops: [],
  };
}

// Fill in fields that older saves or imports may be missing.
function migrate(data) {
  data.trip.home ??= null;
  data.stops.forEach((s) => { s.status ??= 'booked'; });
  return data;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) {
    console.warn('Could not read saved data', e);
  }
  return defaultState();
}

let state = load();
let filter = 'all';

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Could not save', e);
  }
}

// "Ideas" are places you're considering that don't have dates yet.
const isIdea = (s) => s.status === 'idea';
const sortedStops = () =>
  state.stops.filter((s) => !isIdea(s)).sort((a, b) => a.arrive.localeCompare(b.arrive));
const ideaStops = () =>
  state.stops.filter(isIdea).sort((a, b) => a.name.localeCompare(b.name));

function stopStatus(stop) {
  const t = toISO(today());
  if (t < stop.arrive) return 'upcoming';
  if (t >= stop.depart) return 'past';
  return 'current';
}

// ---------- map ----------

const map = L.map('map', { worldCopyJump: true }).setView([40, 50], 3);
// Esri street tiles need no API key. If they fail to load, fall back to OpenStreetMap.
const esriTiles = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  { attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors', maxZoom: 18 }
).addTo(map);

let tileErrors = 0;
esriTiles.on('tileerror', () => {
  if (++tileErrors !== 5) return;
  map.removeLayer(esriTiles);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);
});

const markerLayer = L.layerGroup().addTo(map);
const markersById = {};

map.on('click', async (e) => {
  const latlng = e.latlng.wrap();
  openStopDialog(null, { lat: latlng.lat, lng: latlng.lng });
  reverseGeocode(latlng.lat, latlng.lng);
});

const pinIcon = (cls, label) => L.divIcon({
  className: '',
  html: `<div class="pin ${cls}">${label}</div>`,
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

// Draw one leg of the route. Legs that are shorter going across the
// Pacific (e.g. Asia -> North America) are split at the date line.
function drawLeg(a, b, style) {
  const d = b.lng - a.lng;
  if (Math.abs(d) <= 180) {
    L.polyline([[a.lat, a.lng], [b.lat, b.lng]], style).addTo(markerLayer);
    return;
  }
  const edge = d > 0 ? -180 : 180;
  const bLng = b.lng + (d > 0 ? -360 : 360);
  const t = (edge - a.lng) / (bLng - a.lng);
  const lat = a.lat + t * (b.lat - a.lat);
  L.polyline([[a.lat, a.lng], [lat, edge]], style).addTo(markerLayer);
  L.polyline([[lat, -edge], [b.lat, b.lng]], style).addTo(markerLayer);
}

function popupHTML(s) {
  const when = isIdea(s) ? 'Idea — no dates yet' : `${fmtDate(s.arrive)} → ${fmtDate(s.depart)}`;
  return `
    <strong>${escapeHTML(s.name)}</strong>, ${escapeHTML(s.country)}<br/>
    ${when}${s.status === 'tentative' ? ' · tentative' : ''}
    ${s.notes ? `<p style="margin:6px 0 0">${escapeHTML(s.notes)}</p>` : ''}`;
}

function renderMap(fit = false) {
  markerLayer.clearLayers();
  const stops = sortedStops();
  const ideas = ideaStops();
  const home = state.trip.home;

  stops.forEach((s, i) => {
    const icon = pinIcon(`${s.continent} ${stopStatus(s)} ${s.status}`, i + 1);
    const m = L.marker([s.lat, s.lng], { icon }).addTo(markerLayer).bindPopup(popupHTML(s));
    m.on('click', () => highlight(s.id));
    markersById[s.id] = m;
  });

  ideas.forEach((s) => {
    const m = L.marker([s.lat, s.lng], { icon: pinIcon(`${s.continent} idea`, '?') })
      .addTo(markerLayer).bindPopup(popupHTML(s));
    m.on('click', () => highlight(s.id));
    markersById[s.id] = m;
  });

  if (home) {
    L.marker([home.lat, home.lng], { icon: pinIcon('home', '🏠') })
      .addTo(markerLayer).bindPopup(`<strong>Home</strong> · ${escapeHTML(home.name)}`);
  }

  // Route: home -> stops -> home. Solid where you've been, dashed for what's ahead.
  const route = home && stops.length ? [home, ...stops, home] : stops;
  const offset = route === stops ? 0 : 1;
  const lastDone = stops.findLastIndex((s) => stopStatus(s) !== 'upcoming');
  const tripOver = toISO(today()) >= state.trip.end;
  const doneLegs = tripOver ? route.length : lastDone + offset;
  for (let i = 0; i < route.length - 1; i++) {
    drawLeg(route[i], route[i + 1], i < doneLegs
      ? { color: '#e4572e', weight: 3 }
      : { color: '#6b7280', weight: 2, dashArray: '6 8' });
  }

  const all = [...stops, ...ideas];
  if (fit && all.length) {
    map.fitBounds(all.map((s) => [s.lat, s.lng]), { padding: [40, 40], maxZoom: 6 });
  }
}

function highlight(id) {
  const el = document.querySelector(`[data-id="${id}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- header, progress, stats ----------

function renderHeader() {
  const { name, start, end } = state.trip;
  $('#trip-name').textContent = name;
  $('#trip-dates').textContent = `${fmtDate(start)} – ${fmtDate(end)} · ${daysBetween(start, end)} days`;
  document.title = `${name} · Wanderlog`;

  const total = daysBetween(start, end);
  const elapsed = daysBetween(start, toISO(today()));
  const done = Math.min(Math.max(elapsed, 0), total);
  const pct = total > 0 ? (done / total) * 100 : 0;
  $('#progress-bar').style.width = pct + '%';
  const plural = (n) => `${n} day${n === 1 ? '' : 's'}`;
  $('#progress-label').textContent =
    elapsed < 0 ? `Trip starts in ${plural(-elapsed)}`
    : elapsed >= total ? 'Trip complete — welcome home! 🎉'
    : `Day ${elapsed + 1} of ${total} · ${plural(total - elapsed - 1)} to go`;
}

function routeKm(stops) {
  const home = state.trip.home;
  const route = home && stops.length ? [home, ...stops, home] : stops;
  let km = 0;
  for (let i = 1; i < route.length; i++) km += haversine(route[i - 1], route[i]);
  return km;
}

function renderStats() {
  const stops = sortedStops();
  const countries = new Set(stops.map((s) => s.country.trim().toLowerCase()));
  const nights = stops.reduce((n, s) => n + Math.max(daysBetween(s.arrive, s.depart), 0), 0);
  const booked = stops.filter((s) => s.status === 'booked').length;
  const rated = stops.filter((s) => s.rating > 0);
  const fav = rated.sort((a, b) => b.rating - a.rating)[0];

  const tiles = [
    [stops.length, 'Stops'],
    [countries.size, 'Countries'],
    [Math.round(routeKm(stops)).toLocaleString() + ' km', 'Distance'],
    [nights, 'Nights planned'],
    [`${booked} of ${stops.length}`, 'Booked'],
    [ideaStops().length, 'Ideas to plan'],
    [fav ? escapeHTML(fav.name) : '—', 'Top rated'],
  ];
  $('#stats').innerHTML = tiles
    .map(([v, l]) => `<div class="stat"><div class="value">${v}</div><div class="label">${l}</div></div>`)
    .join('');
}

// ---------- itinerary list ----------

function addListItem(className, text) {
  const li = document.createElement('li');
  li.className = className;
  li.textContent = text;
  $('#stop-list').appendChild(li);
}

function stopItem(s, label) {
  const status = isIdea(s) ? 'idea' : stopStatus(s);
  const li = document.createElement('li');
  li.className = `stop ${s.continent} ${status} ${s.status}`;
  li.dataset.id = s.id;
  const safePhoto = /^https?:\/\//i.test(s.photo || '') ? s.photo : '';
  const nights = isIdea(s) ? 0 : daysBetween(s.arrive, s.depart);
  const when = isIdea(s)
    ? 'No dates yet — double-click to schedule'
    : `${fmtDate(s.arrive)} → ${fmtDate(s.depart)} · ${nights} night${nights === 1 ? '' : 's'}`;
  const badges =
    (status === 'current' ? '<span class="badge">You are here</span>' : '') +
    (s.status === 'tentative' ? '<span class="badge soft">Tentative</span>' : '');
  li.innerHTML = `
    <div class="num">${label}</div>
    <div>
      <div class="title">${escapeHTML(s.name)}${badges}</div>
      <div class="meta">${escapeHTML(s.country)} · ${when}</div>
      ${s.rating ? `<div class="rating">${'★'.repeat(s.rating)}${'☆'.repeat(5 - s.rating)}</div>` : ''}
      ${s.notes ? `<div class="notes">${escapeHTML(s.notes)}</div>` : ''}
      ${safePhoto ? `<img src="${escapeHTML(safePhoto)}" alt="${escapeHTML(s.name)}" loading="lazy" />` : ''}
    </div>`;
  li.addEventListener('click', () => {
    map.flyTo([s.lat, s.lng], isIdea(s) ? 5 : 8, { duration: 0.8 });
    markersById[s.id]?.openPopup();
  });
  li.addEventListener('dblclick', () => openStopDialog(s));
  $('#stop-list').appendChild(li);
}

function renderList() {
  const stops = sortedStops();
  const ideas = ideaStops();
  const home = state.trip.home;
  const showLegs = filter === 'all';
  const km = (a, b) => Math.round(haversine(a, b)).toLocaleString() + ' km';
  $('#stop-list').innerHTML = '';
  $('#empty').hidden = stops.length + ideas.length > 0;

  if (home && stops.length && showLegs) {
    addListItem('leg', `🏠 ${home.name} → ${stops[0].transport || '✈️'} ${km(home, stops[0])}`);
  }
  stops.forEach((s, i) => {
    if (filter !== 'all' && s.continent !== filter) return;
    if (s.leg && s.leg !== stops[i - 1]?.leg) addListItem('section-head', s.leg);
    if (i > 0 && showLegs) addListItem('leg', `${s.transport || '↓'} ${km(stops[i - 1], s)}`);
    stopItem(s, i + 1);
  });
  if (home && stops.length && showLegs) {
    addListItem('leg', `✈️ ${km(stops.at(-1), home)} → 🏠 Home to ${home.name}`);
  }

  const shownIdeas = ideas.filter((s) => filter === 'all' || s.continent === filter);
  if (shownIdeas.length) {
    addListItem('section-head', `Ideas — not scheduled yet (${shownIdeas.length})`);
    shownIdeas.forEach((s) => stopItem(s, '?'));
  }
}

document.querySelectorAll('.chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    filter = chip.dataset.filter;
    renderList();
  })
);

function render(fit = false) {
  renderHeader();
  renderStats();
  renderList();
  renderMap(fit);
}

// ---------- add / edit stop dialog ----------

const stopDialog = $('#stop-dialog');
const stopForm = $('#stop-form');
let editingId = null;

function setStars(n) {
  stopForm.elements.rating.value = n;
  document.querySelectorAll('#star-input button').forEach((b, i) =>
    b.classList.toggle('on', i < n)
  );
}

$('#star-input').innerHTML = [1, 2, 3, 4, 5]
  .map((n) => `<button type="button" data-n="${n}" aria-label="${n} stars">★</button>`)
  .join('');
$('#star-input').addEventListener('click', (e) => {
  const n = Number(e.target.dataset.n);
  if (n) setStars(Number(stopForm.elements.rating.value) === n ? 0 : n);
});

function openStopDialog(stop, preset = {}) {
  editingId = stop?.id ?? null;
  stopForm.reset();
  $('#search-results').innerHTML = '';
  $('#stop-dialog-title').textContent = stop ? 'Edit stop' : 'Add stop';
  $('#btn-delete').hidden = !stop;

  const last = sortedStops().at(-1);
  const data = stop ?? {
    status: 'tentative',
    leg: last?.leg ?? '',
    continent: last?.continent ?? 'Europe',
    ...defaultDates(),
    ...preset,
  };
  if (!stop && preset.lng != null) data.continent = guessContinent(preset.lat, preset.lng);

  for (const [k, v] of Object.entries(data)) {
    if (stopForm.elements[k] && k !== 'rating') stopForm.elements[k].value = v ?? '';
  }
  setStars(data.rating || 0);
  syncDateFields();
  stopDialog.showModal();
  if (!stop && preset.lat == null) $('#place-search').focus();
}

// New stops start where the last dated stop ended.
function defaultDates() {
  const last = sortedStops().at(-1);
  const arrive = last ? last.depart : state.trip.start;
  return { arrive, depart: toISO(addDays(parseDate(arrive), 3)) };
}

// Ideas don't need dates, so hide the date fields for them.
function syncDateFields() {
  const f = stopForm.elements;
  const idea = f.status.value === 'idea';
  document.querySelectorAll('.date-field').forEach((el) => { el.hidden = idea; });
  f.arrive.required = f.depart.required = !idea;
  if (!idea && !f.arrive.value) {
    const d = defaultDates();
    f.arrive.value = d.arrive;
    f.depart.value = d.depart;
  }
}
stopForm.elements.status.addEventListener('change', syncDateFields);

$('#btn-add').addEventListener('click', () => openStopDialog(null));
$('#btn-cancel').addEventListener('click', () => stopDialog.close());

$('#btn-delete').addEventListener('click', () => {
  if (!confirm('Delete this stop?')) return;
  state.stops = state.stops.filter((s) => s.id !== editingId);
  save();
  stopDialog.close();
  render();
});

stopForm.addEventListener('submit', (e) => {
  const f = stopForm.elements;
  const idea = f.status.value === 'idea';
  if (!idea && f.depart.value < f.arrive.value) {
    e.preventDefault();
    alert('Depart date must be on or after arrive date.');
    return;
  }
  const stop = {
    id: editingId ?? uid(),
    name: f.name.value.trim(),
    country: f.country.value.trim(),
    lat: Number(f.lat.value),
    lng: Number(f.lng.value),
    status: f.status.value,
    leg: f.leg.value.trim(),
    arrive: idea ? '' : f.arrive.value,
    depart: idea ? '' : f.depart.value,
    continent: f.continent.value,
    transport: f.transport.value,
    rating: Number(f.rating.value),
    notes: f.notes.value.trim(),
    photo: f.photo.value.trim(),
  };
  const idx = state.stops.findIndex((s) => s.id === stop.id);
  if (idx >= 0) state.stops[idx] = stop;
  else state.stops.push(stop);
  save();
  render(idx < 0);
});

// ---------- place search (OpenStreetMap Nominatim, free, no key) ----------

async function searchPlaces() {
  const q = $('#place-search').value.trim();
  const results = $('#search-results');
  if (!q) return;
  results.innerHTML = '<li class="muted">Searching…</li>';
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&q=${encodeURIComponent(q)}`;
    const data = await (await fetch(url)).json();
    if (!data.length) {
      results.innerHTML = '<li class="muted">No matches — try another spelling, or click the map.</li>';
      return;
    }
    results.innerHTML = '';
    data.forEach((place) => {
      const li = document.createElement('li');
      li.textContent = place.display_name;
      li.addEventListener('click', () => applyPlace(place));
      results.appendChild(li);
    });
  } catch {
    results.innerHTML = '<li class="muted">Search unavailable — enter coordinates or click the map.</li>';
  }
}

function applyPlace(place) {
  const a = place.address || {};
  stopForm.elements.name.value = a.city || a.town || a.village || a.state || place.name || place.display_name.split(',')[0];
  stopForm.elements.country.value = a.country || '';
  stopForm.elements.lat.value = Number(place.lat).toFixed(4);
  stopForm.elements.lng.value = Number(place.lon).toFixed(4);
  stopForm.elements.continent.value = guessContinent(Number(place.lat), Number(place.lon));
  $('#search-results').innerHTML = '';
}

async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${lat}&lon=${lng}`;
    const place = await (await fetch(url)).json();
    if (place && !place.error) applyPlace({ ...place, lat, lon: lng });
  } catch { /* user can type it in */ }
}

$('#btn-search').addEventListener('click', searchPlaces);
$('#place-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); searchPlaces(); }
});

// ---------- trip settings ----------

const settingsDialog = $('#settings-dialog');
const settingsForm = $('#settings-form');

$('#btn-settings').addEventListener('click', () => {
  settingsForm.elements.name.value = state.trip.name;
  settingsForm.elements.start.value = state.trip.start;
  settingsForm.elements.end.value = state.trip.end;
  const home = state.trip.home;
  settingsForm.elements.homeName.value = home?.name ?? '';
  settingsForm.elements.homeLat.value = home?.lat ?? '';
  settingsForm.elements.homeLng.value = home?.lng ?? '';
  settingsDialog.showModal();
});
$('#btn-settings-cancel').addEventListener('click', () => settingsDialog.close());
settingsForm.addEventListener('submit', () => {
  const f = settingsForm.elements;
  // Home is optional: the route starts and ends there when it's set.
  const hasHome = f.homeName.value.trim() && f.homeLat.value !== '' && f.homeLng.value !== '';
  state.trip = {
    name: f.name.value.trim(),
    start: f.start.value,
    end: f.end.value,
    home: hasHome
      ? { name: f.homeName.value.trim(), lat: Number(f.homeLat.value), lng: Number(f.homeLng.value) }
      : null,
  };
  save();
  render();
});

function replaceTrip(newState, label) {
  if (state.stops.length && !confirm(`Replace your current stops with ${label}?`)) return;
  state = newState;
  save();
  settingsDialog.close();
  render(true);
}
$('#btn-demo').addEventListener('click', () => replaceTrip(sampleTrip(), 'the sample trip'));

// ---------- export / import ----------

$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wanderlog-${toISO(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.trip || !Array.isArray(data.stops)) throw new Error('bad format');
    state = migrate(data);
    save();
    render(true);
  } catch {
    alert("That file doesn't look like a Wanderlog backup.");
  }
  e.target.value = '';
});

// ---------- sample data ----------

function sampleTrip() {
  // Start 40 days ago so the demo shows a trip in progress.
  const start = addDays(today(), -40);
  let cursor = start;
  const leg = (name, country, lat, lng, nights, continent, transport, extra = {}) => {
    const arrive = toISO(cursor);
    cursor = addDays(cursor, nights);
    return { id: uid(), name, country, lat, lng, arrive, depart: toISO(cursor), continent, transport, status: 'booked', rating: 0, notes: '', photo: '', ...extra };
  };
  return {
    trip: { name: 'Sample: Europe & Asia', start: toISO(start), end: toISO(addDays(start, 137)), home: null },
    stops: [
      leg('Lisbon', 'Portugal', 38.7223, -9.1393, 5, 'Europe', '✈️ Plane', { rating: 5, notes: 'Pastéis de nata every morning. Sunset at Miradouro da Senhora do Monte.' }),
      leg('Barcelona', 'Spain', 41.3874, 2.1686, 5, 'Europe', '✈️ Plane', { rating: 4, notes: 'Sagrada Família blew my mind.' }),
      leg('Paris', 'France', 48.8566, 2.3522, 4, 'Europe', '🚆 Train', { rating: 4 }),
      leg('Amsterdam', 'Netherlands', 52.3676, 4.9041, 4, 'Europe', '🚆 Train', { rating: 4, notes: 'Biked everywhere.' }),
      leg('Berlin', 'Germany', 52.52, 13.405, 5, 'Europe', '🚆 Train', { rating: 5 }),
      leg('Prague', 'Czechia', 50.0755, 14.4378, 4, 'Europe', '🚌 Bus', { rating: 4 }),
      leg('Vienna', 'Austria', 48.2082, 16.3738, 3, 'Europe', '🚆 Train', { rating: 3 }),
      leg('Budapest', 'Hungary', 47.4979, 19.0402, 5, 'Europe', '🚆 Train', { notes: 'Thermal baths tomorrow!' }),
      leg('Istanbul', 'Türkiye', 41.0082, 28.9784, 6, 'Europe', '✈️ Plane'),
      leg('Delhi', 'India', 28.6139, 77.209, 4, 'Asia', '✈️ Plane'),
      leg('Jaipur', 'India', 26.9124, 75.7873, 3, 'Asia', '🚆 Train'),
      leg('Bangkok', 'Thailand', 13.7563, 100.5018, 6, 'Asia', '✈️ Plane'),
      leg('Chiang Mai', 'Thailand', 18.7883, 98.9853, 6, 'Asia', '🚆 Train'),
      leg('Hanoi', 'Vietnam', 21.0278, 105.8342, 5, 'Asia', '✈️ Plane'),
      leg('Hoi An', 'Vietnam', 15.8801, 108.338, 5, 'Asia', '🚆 Train'),
      leg('Seoul', 'South Korea', 37.5665, 126.978, 7, 'Asia', '✈️ Plane'),
      leg('Tokyo', 'Japan', 35.6762, 139.6503, 8, 'Asia', '✈️ Plane'),
      leg('Kyoto', 'Japan', 35.0116, 135.7681, 5, 'Asia', '🚆 Train'),
    ],
  };
}

// ---------- go ----------

render(true);
