# HackFinder Browser Extension

HackFinder is a simple browser extension that helps you discover hackathons from multiple public sources in one place.
Instead of checking many websites one by one, you can search once and quickly browse relevant events.

## What this product is

HackFinder is a Chrome extension (popup tool), not a full website.
You open it from the browser toolbar and run searches directly inside the popup.

## Who this helps

- Students looking for hackathons to join
- Developers searching for online or local events
- Teams filtering events by domain (AI/ML, Web3, FinTech, etc.)

## Why this is useful

Without this tool, people usually:

1. Visit multiple event websites
2. Search each source separately
3. Compare location and date manually

With HackFinder, you can:

1. Enter a city (or use the location button)
2. Select domains
3. Search once
4. View grouped results quickly (Nearby, Online, Far, Others)

This reduces time and makes event discovery easier, especially for beginners.

## Where it helps most

- Finding hackathons near your location
- Discovering domain-specific events
- Separating online from in-person opportunities
- Opening the original listing directly from the card

## Data sources

- MLH
- Public source aggregation listings
- Optional API connectors can be configured for additional sources (for example Eventbrite/Meetup), depending on credentials and availability

## Main features

- Domain-based filtering
- Geolocation + reverse geocoding support
- Distance-based categorization
- 2-hour cache for repeated same-query searches
- Lightweight popup UI with source attribution per listing


## How to load in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `/extension` folder that you just cloned or downloaded from this repo
5. Pin the extension and click it to open

## How to use

1. Enter your city (or click the location icon)
2. Select one or more domain tags
3. Click `Search Hackathons`
4. Switch between result categories
5. Click `View Hackathon` to open the original event page

## Notes

- Results depend on network availability and source response behavior.
- Some sources can change format or rate-limit requests.
- Required permissions and host access are defined in `manifest.json`.
