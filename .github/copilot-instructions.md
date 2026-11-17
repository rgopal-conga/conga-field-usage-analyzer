# Working on this repository

This app ships as **two runtimes from one codebase**: a standalone local site (`npm start`) and a Chrome extension (`npm run build:extension`). Every change must work in both. Follow the rules in the README section "One codebase, two runtimes":

1. API routes live only in `server/api.js`; `server/index.js` is a thin HTTP host.
2. The UI calls the API only through `request()` in `public/app.js`.
3. Shared modules (`server/*.js` except `index.js`) stay browser-safe: no `node:` imports, `Buffer`, `fs` or direct `process`.
4. No persistent storage anywhere (no localStorage, sessionStorage, IndexedDB, cookies, `chrome.storage`).
5. New Conga hosts go in `server/platformUrl.js` and, if outside the existing domains, `extension/manifest.base.json`.
6. Run `npm run check` (tests both runtimes and builds the extension) before committing.
