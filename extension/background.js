// Clicking the toolbar icon opens the analyzer in a full browser tab (or focuses it if it
// is already open). Scans run in that tab, not in this service worker, so Chrome cannot
// stop a long scan by suspending an idle worker. Nothing is stored.
const appUrl = chrome.runtime.getURL('index.html');

chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.tabs.query({ url: appUrl });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: appUrl });
});
