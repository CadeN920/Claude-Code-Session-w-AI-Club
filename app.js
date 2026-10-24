// Wanderlog — a tiny travel tracker. Data lives in localStorage and, when
// signed in, is also synced to Supabase so every device sees the same trip.

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

// Country flags: from the code saved when a place is picked from search,
// or looked up by name for stops typed in by hand.
const COUNTRY_CODES = {
  albania: 'AL', austria: 'AT', belgium: 'BE', 'bosnia and herzegovina': 'BA', cambodia: 'KH', china: 'CN',
  croatia: 'HR', czechia: 'CZ', 'czech republic': 'CZ', denmark: 'DK', egypt: 'EG', france: 'FR',
  germany: 'DE', greece: 'GR', hungary: 'HU', iceland: 'IS', india: 'IN', indonesia: 'ID', ireland: 'IE',
  israel: 'IL', italy: 'IT', japan: 'JP', jordan: 'JO', laos: 'LA', malaysia: 'MY', mexico: 'MX',
  montenegro: 'ME', morocco: 'MA', nepal: 'NP', netherlands: 'NL', 'north macedonia': 'MK', norway: 'NO',
  philippines: 'PH', poland: 'PL', portugal: 'PT', serbia: 'RS', singapore: 'SG', slovakia: 'SK',
  slovenia: 'SI', 'south korea': 'KR', spain: 'ES', 'sri lanka': 'LK', sweden: 'SE', switzerland: 'CH',
  taiwan: 'TW', thailand: 'TH', turkey: 'TR', 'türkiye': 'TR', 'united arab emirates': 'AE',
  'united kingdom': 'GB', 'united states': 'US', vietnam: 'VN', 'viet nam': 'VN',
};
function flagFor(s) {
  const code = COUNTRY_CODES[(s.country || '').trim().toLowerCase()] || (s.countryCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  const flag = String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)));
  return `<span class="flag">${flag}</span>`;
}

// ---------- state ----------

function defaultState() {
  const start = today();
  return {
    trip: { name: 'My Trip', start: toISO(start), end: toISO(addDays(start, 137)), home: null },
    stops: [],
    bookings: [],
  };
}

// Fill in fields that older saves or imports may be missing.
function migrate(data) {
  data.trip.home ??= null;
  data.stops.forEach((s) => { s.status ??= 'booked'; });
  data.bookings ??= [];
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

// A family "view only" link carries ?view=<token>. That mode never reads or
// writes this browser's saved trip.
const viewToken = new URLSearchParams(location.search).get('view');
const readOnly = !!viewToken;

let state = readOnly ? defaultState() : load();
let filter = 'all';

function saveLocal() {
  if (readOnly) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Could not save', e);
  }
}

// Every edit goes through here: save on this device, then upload if signed in.
function save() {
  saveLocal();
  queueUpload();
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
  if (readOnly) return;
  const latlng = e.latlng.wrap();
  openStopDialog(null, { lat: latlng.lat, lng: latlng.lng });
  reverseGeocode(latlng.lat, latlng.lng);
});

const pinIcon = (cls, label) => {
  // Wider pill for combined labels like "2·5".
  const width = Math.max(26, 16 + String(label).length * 7);
  return L.divIcon({
    className: '',
    html: `<div class="pin ${cls}">${label}</div>`,
    iconSize: [width, 26],
    iconAnchor: [width / 2, 13],
  });
};

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
  return `<div class="popup-stop">
    ${flagFor(s)}<strong>${escapeHTML(s.name)}</strong>, ${escapeHTML(s.country)}<br/>
    ${when}${s.status === 'tentative' ? ' · tentative' : ''}
    ${s.notes ? `<p style="margin:6px 0 0">${escapeHTML(s.notes)}</p>` : ''}</div>`;
}

function renderMap(fit = false) {
  markerLayer.clearLayers();
  const stops = sortedStops();
  const ideas = ideaStops();
  const home = state.trip.home;

  // Stops at the same place (e.g. Madrid twice) share one pin labelled "2·5".
  const groups = new Map();
  stops.forEach((s, i) => {
    const key = `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ s, n: i + 1 });
  });
  groups.forEach((group) => {
    const first = group[0].s;
    const statuses = group.map(({ s }) => stopStatus(s));
    const cls = [
      first.continent,
      statuses.includes('current') ? 'current' : statuses[0],
      group.every(({ s }) => s.status === 'booked') ? 'booked' : 'tentative',
    ].join(' ');
    const m = L.marker([first.lat, first.lng], { icon: pinIcon(cls, group.map((g) => g.n).join('·')) })
      .addTo(markerLayer)
      .bindPopup(group.map(({ s }) => popupHTML(s)).join(''));
    m.on('click', () => highlight(first.id));
    group.forEach(({ s }) => { markersById[s.id] = m; });
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
    ideaStops().length && [ideaStops().length, 'Ideas to plan'],
    fav && [escapeHTML(fav.name), 'Top rated'],
  ].filter(Boolean);
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
      <div class="title">${flagFor(s)}${escapeHTML(s.name)}${badges}</div>
      <div class="meta">${escapeHTML(s.country)} · ${when}</div>
      ${bookingChips(s)}
      ${s.rating ? `<div class="rating">${'★'.repeat(s.rating)}${'☆'.repeat(5 - s.rating)}</div>` : ''}
      ${s.notes ? `<div class="notes">${escapeHTML(s.notes)}</div>` : ''}
      ${safePhoto ? `<img src="${escapeHTML(safePhoto)}" alt="${escapeHTML(s.name)}" loading="lazy" />` : ''}
    </div>`;
  li.addEventListener('click', () => {
    map.flyTo([s.lat, s.lng], isIdea(s) ? 5 : 8, { duration: 0.8 });
    markersById[s.id]?.openPopup();
  });
  li.addEventListener('dblclick', () => openStopDialog(s));
  li.querySelectorAll('.bchip').forEach((chip) => chip.addEventListener('click', (e) => {
    e.stopPropagation();
    showBooking(chip.dataset.booking);
  }));
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

document.querySelectorAll('#filters .chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    document.querySelectorAll('#filters .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    filter = chip.dataset.filter;
    renderList();
  })
);

function render(fit = false) {
  renderHeader();
  renderNextUp();
  renderStats();
  renderList();
  renderBookings();
  renderMap(fit);
}

// ---------- bookings: flights, trains, stays & confirmations ----------

const BOOKING_TYPES = {
  flight: { icon: '✈️', start: 'Departs', end: 'Arrives' },
  train: { icon: '🚆', start: 'Departs', end: 'Arrives' },
  bus: { icon: '🚌', start: 'Departs', end: 'Arrives' },
  ferry: { icon: '⛴️', start: 'Departs', end: 'Arrives' },
  stay: { icon: '🏠', start: 'Check-in', end: 'Check-out' },
  activity: { icon: '🎟️', start: 'Starts', end: 'Ends' },
};
const bookingIcon = (b) => BOOKING_TYPES[b.type]?.icon ?? '🎟️';

// Booking times are stored as typed ("2027-01-06T17:30"), in the local time
// of the place, and shown the same way.
function nowLocal() {
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function fmtDateTime(s) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ` +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
const sortedBookings = () => [...state.bookings].sort((a, b) => a.start.localeCompare(b.start));
const bookingsForStop = (s) => sortedBookings().filter((b) => b.stopId === s.id);

function bookingChips(s) {
  const list = bookingsForStop(s);
  if (!list.length) return '';
  return `<div class="booking-chips">${list.map((b) =>
    `<button type="button" class="bchip" data-booking="${b.id}">${bookingIcon(b)} ${escapeHTML(b.title)}</button>`
  ).join('')}</div>`;
}

// Pick the stop a booking belongs to: transport goes with the stop you arrive
// at (overnight flights land the next day); stays and activities with the
// stop whose dates include them.
function autoStopId(type, start, end) {
  const transport = !['stay', 'activity'].includes(type);
  const day = ((transport && end) || start).slice(0, 10);
  const stops = sortedStops();
  const match = (transport && stops.find((s) => s.arrive === day)) ||
    stops.find((s) => s.arrive <= day && day < s.depart);
  return match?.id ?? '';
}

function renderNextUp() {
  const now = nowLocal();
  const list = sortedBookings();
  const staying = list.find((b) => b.type === 'stay' && b.start <= now && now < (b.end || b.start));
  const next = list.find((b) => b.start > now);
  const card = (label, b, when) => `
    <button type="button" class="next-card" data-booking="${b.id}">
      <span class="next-label">${label}</span>
      <span class="next-title">${bookingIcon(b)} ${escapeHTML(b.title)}</span>
      <span class="muted">${when}${b.confirmation ? ` · Conf. <span class="conf">${escapeHTML(b.confirmation)}</span>` : ''}</span>
    </button>`;
  const parts = [];
  if (staying) parts.push(card('Staying at', staying, `until ${fmtDateTime(staying.end)}`));
  if (next) {
    const days = daysBetween(toISO(today()), next.start.slice(0, 10));
    const soon = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    parts.push(card('Next up', next, `${fmtDateTime(next.start)} · ${soon}`));
  }
  const el = $('#next-up');
  el.innerHTML = parts.join('');
  el.hidden = !parts.length;
  el.querySelectorAll('.next-card').forEach((c) =>
    c.addEventListener('click', () => showBooking(c.dataset.booking)));
}

function bookingItem(b) {
  const stop = state.stops.find((s) => s.id === b.stopId);
  const link = /^https?:\/\//i.test(b.link || '') ? b.link : '';
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.address || '')}`;
  const li = document.createElement('li');
  li.className = `booking${(b.end || b.start) < nowLocal() ? ' past' : ''}`;
  li.dataset.id = b.id;
  li.innerHTML = `
    <div class="b-icon">${bookingIcon(b)}</div>
    <div>
      <div class="title">${escapeHTML(b.title)}</div>
      <div class="meta">${fmtDateTime(b.start)}${b.end ? ` → ${fmtDateTime(b.end)}` : ''}</div>
      ${b.provider || b.confirmation ? `<div class="meta">
        ${escapeHTML(b.provider || '')}${b.provider && b.confirmation ? ' · ' : ''}
        ${b.confirmation ? `Conf. <span class="conf">${escapeHTML(b.confirmation)}</span>
          <button type="button" class="copy">Copy</button>` : ''}
      </div>` : ''}
      ${b.details ? `<div class="notes">${escapeHTML(b.details)}</div>` : ''}
      ${b.address ? `<div class="notes"><a href="${mapsUrl}" target="_blank" rel="noopener">📍 ${escapeHTML(b.address)}</a></div>` : ''}
      ${link ? `<div class="notes"><a href="${escapeHTML(link)}" target="_blank" rel="noopener">Open booking ↗</a></div>` : ''}
      ${b.notes ? `<div class="notes">${escapeHTML(b.notes)}</div>` : ''}
      ${stop ? `<div class="meta">For: ${escapeHTML(stop.name)}</div>` : ''}
    </div>`;
  li.querySelector('.copy')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(b.confirmation);
      e.target.textContent = 'Copied!';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
    } catch { /* clipboard blocked: the number is visible to copy by hand */ }
  });
  li.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
  li.addEventListener('click', () => openBookingDialog(b));
  return li;
}

function renderBookings() {
  const list = $('#booking-list');
  list.innerHTML = '';
  const all = sortedBookings();
  $('#bookings-empty').hidden = all.length > 0;
  const now = nowLocal();
  const upcoming = all.filter((b) => (b.end || b.start) >= now);
  const past = all.filter((b) => (b.end || b.start) < now);
  const head = (text) => {
    const li = document.createElement('li');
    li.className = 'section-head';
    li.textContent = text;
    list.appendChild(li);
  };
  if (upcoming.length) head(`Upcoming (${upcoming.length})`);
  upcoming.forEach((b) => list.appendChild(bookingItem(b)));
  if (past.length) head(`Past (${past.length})`);
  past.forEach((b) => list.appendChild(bookingItem(b)));
}

// Tabs in the side panel.
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#itinerary-panel').hidden = name !== 'itinerary';
  $('#bookings-panel').hidden = name !== 'bookings';
  $('#filters').hidden = name !== 'itinerary';
  $('#btn-add-booking').hidden = name !== 'bookings' || readOnly;
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

function showBooking(id) {
  showTab('bookings');
  const el = document.querySelector(`#booking-list [data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1500);
}

// ---------- add / edit booking dialog ----------

const bookingDialog = $('#booking-dialog');
const bookingForm = $('#booking-form');
let editingBookingId = null;

function syncBookingLabels() {
  const t = BOOKING_TYPES[bookingForm.elements.type.value];
  $('#booking-start-label').textContent = t.start;
  $('#booking-end-label').textContent = t.end;
}
bookingForm.elements.type.addEventListener('change', syncBookingLabels);

function openBookingDialog(b) {
  if (readOnly) return;
  editingBookingId = b?.id ?? null;
  bookingForm.reset();
  $('#booking-dialog-title').textContent = b ? 'Edit booking' : 'Add booking';
  $('#btn-delete-booking').hidden = !b;
  bookingForm.elements.stopId.innerHTML =
    '<option value="">Auto (match by date)</option>' +
    sortedStops().map((s, i) =>
      `<option value="${s.id}">${i + 1}. ${escapeHTML(s.name)} (${fmtDate(s.arrive)} – ${fmtDate(s.depart)})</option>`
    ).join('');
  const data = b ?? { type: 'flight' };
  for (const [k, v] of Object.entries(data)) {
    if (bookingForm.elements[k]) bookingForm.elements[k].value = v ?? '';
  }
  syncBookingLabels();
  bookingDialog.showModal();
}

$('#btn-add-booking').addEventListener('click', () => openBookingDialog(null));
$('#btn-cancel-booking').addEventListener('click', () => bookingDialog.close());

$('#btn-delete-booking').addEventListener('click', () => {
  if (!confirm('Delete this booking?')) return;
  state.bookings = state.bookings.filter((b) => b.id !== editingBookingId);
  save();
  bookingDialog.close();
  render();
});

bookingForm.addEventListener('submit', (e) => {
  const f = bookingForm.elements;
  if (f.end.value && f.end.value < f.start.value) {
    e.preventDefault();
    alert(`${$('#booking-end-label').textContent} must be after ${$('#booking-start-label').textContent.toLowerCase()}.`);
    return;
  }
  const field = (k) => f[k].value.trim();
  const booking = {
    id: editingBookingId ?? uid(),
    type: f.type.value,
    title: field('title'),
    start: f.start.value,
    end: f.end.value,
    provider: field('provider'),
    confirmation: field('confirmation'),
    details: field('details'),
    address: field('address'),
    link: field('link'),
    notes: field('notes'),
    stopId: f.stopId.value || autoStopId(f.type.value, f.start.value, f.end.value),
  };
  const idx = state.bookings.findIndex((b) => b.id === booking.id);
  if (idx >= 0) state.bookings[idx] = booking;
  else state.bookings.push(booking);
  save();
  render();
});

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
  if (readOnly) return;
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
    countryCode: f.countryCode.value,
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
  stopForm.elements.countryCode.value = a.country_code || '';
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

// ---------- "⋯" menu (trip settings, export, import) ----------

const moreMenu = $('#more-menu');
function setMenu(open) {
  moreMenu.hidden = !open;
  $('#btn-more').setAttribute('aria-expanded', String(open));
}
$('#btn-more').addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(moreMenu.hidden);
});
moreMenu.addEventListener('click', (e) => { if (e.target.closest('button')) setMenu(false); });
$('#file-import').addEventListener('change', () => setMenu(false));
document.addEventListener('click', (e) => { if (!e.target.closest('.more')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

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
  const stops = [
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
  ];
  const istanbul = stops[8];
  const delhi = stops[9];
  const booking = (type, title, startTime, endTime, stop, extra) => ({
    id: uid(), type, title, start: startTime, end: endTime, stopId: stop.id,
    provider: '', confirmation: '', details: '', address: '', link: '', notes: '', ...extra,
  });
  return {
    trip: { name: 'Sample: Europe & Asia', start: toISO(start), end: toISO(addDays(start, 137)), home: null },
    stops,
    bookings: [
      booking('stay', 'Hostel in Sultanahmet', `${istanbul.arrive}T15:00`, `${istanbul.depart}T11:00`, istanbul, {
        provider: 'Hostelworld', confirmation: 'HW-48213', address: 'Sultanahmet, Istanbul',
      }),
      booking('flight', 'Istanbul → Delhi', `${istanbul.depart}T14:10`, `${delhi.arrive}T22:55`, delhi, {
        provider: 'Turkish Airlines', confirmation: 'TK7Q2P', details: 'TK 716 · Seat 31A · Istanbul Airport (IST)',
        notes: '1 checked bag included. Online check-in opens 24h before.',
      }),
    ],
  };
}

// ---------- cloud sync (Supabase, optional) ----------

const PENDING_KEY = 'wanderlog-pending'; // set while this device has edits the cloud hasn't seen
const TRIP_ID_KEY = 'wanderlog-trip-id';
const cfg = window.WANDERLOG_CONFIG || {};
const sb = cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase
  ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
  : null;

let user = null;
let trip = null;         // { id, owner_id, share_token } of the cloud trip this device follows
let busy = false;        // a sync is in flight
let editVersion = 0;     // bumps on every local edit
let lastCloudUpdate = null;
let uploadTimer = null;

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* nothing to do */ }
}
const hasPending = () => storageGet(PENDING_KEY) === '1';
const setPending = (on) => storageSet(PENDING_KEY, on ? '1' : null);

function rememberTrip(t) {
  trip = t;
  storageSet(TRIP_ID_KEY, t?.id ?? null);
}

// The database may reorder object keys, so compare trips with sorted keys.
function sameTrip(a, b) {
  const canon = (v) => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
      : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

const SYNC_LABELS = {
  'signed-out': ['☁︎ Sign in to sync', ''],
  saving: ['☁︎ Saving…', ''],
  synced: ['☁︎ Synced', 'synced'],
  offline: ['☁︎ Offline — will sync', 'problem'],
  error: ['⚠︎ Sync problem', 'problem'],
};

function setSyncState(name) {
  const [label, cls] = SYNC_LABELS[name];
  const btn = $('#btn-sync');
  // Icon stays visible on phones; the words hide on narrow screens.
  const [icon, ...words] = label.split(' ');
  btn.innerHTML = `${icon} <span class="label">${words.join(' ')}</span>`;
  btn.title = label;
  btn.className = `ghost ${cls}`;
  $('#btn-share').hidden = !user;
  $('#auth-status').textContent = {
    saving: 'Saving your latest changes…',
    synced: 'All changes are saved to your account.',
    offline: "You're offline. Changes are saved on this device and will upload when you're back online.",
    error: "Couldn't reach the server. Changes are saved on this device; try Sync now.",
  }[name] ?? '';
}

function syncFailed(e) {
  console.warn('Sync failed', e);
  setSyncState(navigator.onLine ? 'error' : 'offline');
}

// The trip this account follows: the one used last on this device, otherwise
// the most recently updated trip it owns or was added to as an editor.
async function fetchCloudTrip() {
  const { data, error } = await sb.from('trips')
    .select('id, owner_id, share_token, data, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  const lastUsed = storageGet(TRIP_ID_KEY);
  return data.find((t) => t.id === lastUsed) ?? data[0] ?? null;
}

async function uploadTrip() {
  const version = editVersion;
  const row = { data: state, updated_at: new Date().toISOString() };
  setSyncState('saving');
  const cols = 'id, owner_id, share_token';
  // After a reload only the trip's id is known, so fall back to the saved one.
  const id = trip?.id ?? storageGet(TRIP_ID_KEY);
  let result = id
    ? await sb.from('trips').update(row).eq('id', id).select(cols).single()
    : null;
  // No trip yet, or it's gone (deleted, or no longer shared with us): start one.
  if (!result || result.error?.code === 'PGRST116') {
    result = await sb.from('trips').insert(row).select(cols).single();
  }
  const { data, error } = result;
  if (error) throw error;
  rememberTrip(data);
  lastCloudUpdate = row.updated_at;
  // Only clear the flag if nothing changed while we were uploading.
  if (version === editVersion) {
    setPending(false);
    setSyncState('synced');
  }
}

// Called after every edit: upload shortly after the user stops typing.
function queueUpload() {
  if (!user) return;
  editVersion++;
  setPending(true);
  setSyncState('saving');
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(async () => {
    if (busy) return queueUpload();
    busy = true;
    try { await uploadTrip(); } catch (e) { syncFailed(e); } finally { busy = false; }
  }, 800);
}

// Make this device and the cloud agree. Unsynced edits here win; otherwise
// the cloud copy (possibly edited on another device or by a travel partner)
// replaces this one.
async function reconcile({ justSignedIn = false } = {}) {
  if (!user || busy) return;
  busy = true;
  try {
    if (hasPending()) return await uploadTrip();

    const cloud = await fetchCloudTrip();
    if (!cloud) {
      rememberTrip(null);
      if (state.stops.length) await uploadTrip();
      else setSyncState('synced');
      return;
    }
    rememberTrip(cloud);
    if (lastCloudUpdate && Date.parse(cloud.updated_at) === Date.parse(lastCloudUpdate)) {
      return setSyncState('synced');
    }
    if (!sameTrip(cloud.data, state)) {
      const keepThisDevice = justSignedIn && state.stops.length && !confirm(
        `Your account already has a trip ("${cloud.data.trip.name}", ${cloud.data.stops.length} stops).\n\n` +
        `OK: show that trip on this device.\n` +
        `Cancel: replace it with the trip on this device ("${state.trip.name}", ${state.stops.length} stops).`
      );
      if (keepThisDevice) return await uploadTrip();
      state = migrate(cloud.data);
      saveLocal();
      render(justSignedIn);
    }
    lastCloudUpdate = cloud.updated_at;
    setSyncState('synced');
  } catch (e) {
    syncFailed(e);
  } finally {
    busy = false;
  }
}

// ---------- sign in / out ----------

const authDialog = $('#auth-dialog');
const authForm = $('#auth-form');

function showError(id, msg) {
  $(id).textContent = msg;
  $(id).hidden = !msg;
}

$('#btn-sync').addEventListener('click', () => {
  $('#auth-signed-out').hidden = !!user;
  $('#auth-signed-in').hidden = !user;
  $('#auth-email').textContent = user?.email ?? '';
  showError('#auth-error', '');
  authDialog.showModal();
});
$('#btn-auth-cancel').addEventListener('click', () => authDialog.close());
$('#btn-auth-close').addEventListener('click', () => authDialog.close());
$('#btn-sync-now').addEventListener('click', () => reconcile());

async function signIn(create) {
  const email = authForm.elements.email.value.trim();
  const password = authForm.elements.password.value;
  if (!email || !password) return showError('#auth-error', 'Enter your email and a password.');
  if (create && password.length < 6) return showError('#auth-error', 'Use a password of at least 6 characters.');
  showError('#auth-error', '');
  try {
    const { data, error } = create
      ? await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })
      : await sb.auth.signInWithPassword({ email, password });
    if (error) return showError('#auth-error', error.message);
    if (!data.session) {
      return showError('#auth-error', 'Almost done: check your email and click the confirmation link. It brings you back here signed in.');
    }
    user = data.session.user;
    authForm.elements.password.value = '';
    authDialog.close();
    await reconcile({ justSignedIn: true });
  } catch (e) {
    showError('#auth-error', "Couldn't reach the server. Check your connection and try again.");
  }
}

authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  signIn(false);
});
$('#btn-signup').addEventListener('click', () => signIn(true));

$('#btn-signout').addEventListener('click', async () => {
  if (hasPending() && !confirm("Some changes haven't uploaded yet and will be lost. Sign out anyway?")) return;
  try { await sb.auth.signOut(); } catch { /* still clear this device */ }
  user = null;
  lastCloudUpdate = null;
  rememberTrip(null);
  setPending(false);
  state = defaultState();
  saveLocal();
  authDialog.close();
  render(true);
  setSyncState('signed-out');
});

// ---------- sharing ----------

const shareDialog = $('#share-dialog');
const shareUrl = (token) => `${location.origin}${location.pathname}?view=${token}`;

async function renderShareDialog() {
  const isOwner = trip?.owner_id === user.id;
  $('#share-owner').hidden = !isOwner;
  $('#share-not-owner').hidden = isOwner;
  if (!isOwner) return;

  $('#share-link-on').hidden = !trip.share_token;
  $('#btn-make-link').hidden = !!trip.share_token;
  $('#share-link').value = trip.share_token ? shareUrl(trip.share_token) : '';

  const { data, error } = await sb.from('trip_editors').select('email').eq('trip_id', trip.id).order('email');
  if (error) throw error;
  const list = $('#editor-list');
  list.innerHTML = data.length ? '' : '<li class="muted">No travel partners added yet.</li>';
  data.forEach(({ email }) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHTML(email)}</span>`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => shareAction(async () => {
      if (!confirm(`Stop sharing this trip with ${email}?`)) return;
      const { error } = await sb.from('trip_editors').delete().eq('trip_id', trip.id).eq('email', email);
      if (error) throw error;
    }));
    li.appendChild(remove);
    list.appendChild(li);
  });
}

// Run a sharing change, then refresh the dialog; show any error inline.
async function shareAction(fn) {
  showError('#share-error', '');
  try {
    await fn();
    await renderShareDialog();
  } catch (e) {
    console.warn(e);
    showError('#share-error', e.message || "Couldn't reach the server. Try again.");
  }
}

$('#btn-share').addEventListener('click', () => {
  shareDialog.showModal();
  shareAction(async () => {
    // A brand-new trip may not be in the cloud yet.
    if (!trip) await uploadTrip();
  });
});
$('#btn-share-close').addEventListener('click', () => shareDialog.close());

$('#btn-add-editor').addEventListener('click', () => shareAction(async () => {
  const email = $('#editor-email').value.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter your travel partner\'s email address.');
  const { error } = await sb.from('trip_editors').insert({ trip_id: trip.id, email });
  if (error) throw new Error(error.code === '23505' ? `${email} is already added.` : error.message);
  $('#editor-email').value = '';
}));

async function makeShareLink() {
  const { data, error } = await sb.rpc('new_share_link', { trip: trip.id });
  if (error) throw error;
  trip.share_token = data;
}
$('#btn-make-link').addEventListener('click', () => shareAction(makeShareLink));
$('#btn-reset-link').addEventListener('click', () => shareAction(async () => {
  if (confirm('Make a new link? The current link will stop working.')) await makeShareLink();
}));
$('#btn-stop-link').addEventListener('click', () => shareAction(async () => {
  if (!confirm('Turn off the family link? Anyone using it will no longer see the trip.')) return;
  const { error } = await sb.rpc('stop_share_link', { trip: trip.id });
  if (error) throw error;
  trip.share_token = null;
}));
$('#btn-copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#share-link').value);
    $('#btn-copy-link').textContent = 'Copied!';
  } catch {
    $('#share-link').select();
    $('#btn-copy-link').textContent = 'Press Ctrl/Cmd+C';
  }
  setTimeout(() => { $('#btn-copy-link').textContent = 'Copy'; }, 2000);
});

// ---------- startup ----------

async function startSync() {
  if (!sb) return; // sync not configured: the app works on this device only
  $('#btn-sync').hidden = false;
  try {
    const { data } = await sb.auth.getSession();
    user = data.session?.user ?? null;
  } catch {
    user = null;
  }
  setSyncState(user ? 'saving' : 'signed-out');
  if (user) await reconcile();

  // Pick up changes made elsewhere when coming back to the app.
  const refresh = () => { if (user && !document.hidden) reconcile(); };
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', refresh);
}

// Family link (?view=…): show the shared trip read-only, without touching
// this browser's own saved trip.
async function startViewOnly() {
  document.body.classList.add('readonly');
  const banner = $('#view-banner');
  banner.hidden = false;
  let first = true;
  const load = async () => {
    try {
      if (!sb) throw new Error('not configured');
      const { data, error } = await sb.rpc('get_shared_trip', { token: viewToken });
      if (error) throw error;
      if (!data) {
        banner.textContent = 'This link is no longer active. Ask for a new one.';
        return;
      }
      banner.textContent = '👀 View only — this trip was shared with you.';
      if (first || !sameTrip(data, state)) {
        state = migrate(data);
        render(first);
        first = false;
      }
    } catch (e) {
      console.warn(e);
      banner.textContent = "Couldn't load the trip. Check your connection and refresh.";
    }
  };
  await load();
  const refresh = () => { if (!document.hidden) load(); };
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
}

// ---------- go ----------

render(true);
if (readOnly) startViewOnly();
else startSync();
