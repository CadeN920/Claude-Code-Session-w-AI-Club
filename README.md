# Wanderlog — Europe & Asia travel tracker

A no-build web app for tracking a 4.5-month trip through Europe and Asia.

## Features
- **Interactive map** (Leaflet + OpenStreetMap) with numbered stops, a solid line for where you've been and a dashed line for what's ahead
- **Itinerary timeline** with dates, nights, transport, star ratings, journal notes and photos; "You are here" badge on the current stop
- **Trip progress bar** and stats: stops, countries, km traveled, nights, booked count, ideas to plan, top-rated stop
- **Place search** (free OpenStreetMap geocoding), or click anywhere on the map to add a stop
- **Saves automatically** in your browser (localStorage); Export/Import JSON for backups
- **Booked, tentative, or idea:** ideas are places you're considering with no dates yet (shown as dashed "?" pins); double-click one to schedule it
- **Home city** (optional, under ⚙︎ Trip): the route starts and ends there, and those flights count toward distance
- **Regions:** Europe, Africa, Asia, with filters
- **Sample trip** under ⚙︎ Trip → "Load sample trip" shows a full example

Your own plan isn't stored in this repo: keep it as an Export file and use ⬆︎ Import to load it.

## Run it
Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

Tip: double-click a stop in the itinerary to edit or delete it.
