# Wanderlog — Europe & Asia travel tracker

A no-build web app for tracking a 4.5-month trip through Europe and Asia.

## Features
The app is organized into tabs: **🏠 Home · 🗺️ Trip · 🎫 Bookings · ✅ To-dos · 👤 Profile** (along the top on a laptop, along the bottom on a phone).

- **Home:** trip countdown, Next up, what needs attention, the next few stops, and key stats
- **To-dos:** reminders worked out from your trip (book transport and stays, online check-in, entry and visa rules, pre-trip checklist), grouped by month, plus your own tasks with due dates; suggested ones can be ticked off or dismissed
- **Schengen 90/180 counter:** your busiest 180-day window in the Schengen area, for US passport holders
- **Travel profile:** a quick quiz (early bird or night owl, interests, food, pace, budget, goals) that will drive personalized recommendations
- **Interactive map** (Leaflet + OpenStreetMap) with numbered stops, a solid line for where you've been and a dashed line for what's ahead
- **Itinerary timeline** with dates, nights, transport, star ratings, journal notes and photos; "You are here" badge on the current stop
- **Trip progress bar** and stats: stops, countries, km traveled, nights, booked count, ideas to plan, top-rated stop
- **Place search** (free OpenStreetMap geocoding), or click anywhere on the map to add a stop
- **Saves automatically** in your browser (localStorage); Export/Import JSON for backups
- **Booked, tentative, or idea:** ideas are places you're considering with no dates yet (shown as dashed "?" pins); double-click one to schedule it
- **Home city** (optional, under ⚙︎ Trip): the route starts and ends there, and those flights count toward distance
- **Regions:** Europe, Africa, Asia, with filters
- **Bookings wallet:** flights, trains, buses, ferries, stays and activities with times, confirmation numbers (one-tap copy), addresses (open in Maps), links and notes. A **Staying at / Next up** card shows where you're sleeping and your next departure; each stop shows its bookings as chips
- **Sample trip** under ⚙︎ Trip → "Load sample trip" shows a full example

Your own plan isn't stored in this repo: keep it as an Export file and use ⬆︎ Import to load it.

## Sync and sharing (optional)
With a free [Supabase](https://supabase.com) project, the app adds:
- **☁︎ Sign in to sync:** your trip stays the same on every device you sign in on.
- **👥 Share → Travel partners:** add someone's email; once they create an account with it, they can edit the same trip.
- **👥 Share → Family link:** a view-only link that needs no account. You can make a new one (the old one stops working) or turn it off.

Setup:
1. Create a Supabase project.
2. In **SQL Editor**, run [`supabase/setup.sql`](supabase/setup.sql).
3. Under **Authentication → URL Configuration**, set **Site URL** to the site's address so email confirmation links come back to the app.
4. Put the project's URL and anon (publishable) key in [`config.js`](config.js).

The anon key is designed to be public: the database's row-level security only lets each account read the trips it owns or was added to, and the family link only reveals the one trip it belongs to. Without `config.js` values, the app works on a single device as before.

## Run it
Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

Tip: double-click a stop in the itinerary to edit or delete it.
