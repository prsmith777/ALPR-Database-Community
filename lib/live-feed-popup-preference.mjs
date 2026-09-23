export const LIVE_FEED_POPUP_VIEW_STORAGE_KEY = "alpr.live-feed.popup-view.v1";

export function normalizeLiveFeedPopupView(value) {
  return value === "vehicle" ? "vehicle" : "plate";
}

function browserStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadLiveFeedPopupView(storage = browserStorage()) {
  try {
    return normalizeLiveFeedPopupView(storage?.getItem(LIVE_FEED_POPUP_VIEW_STORAGE_KEY));
  } catch {
    return "plate";
  }
}

export function saveLiveFeedPopupView(value, storage = browserStorage()) {
  const normalized = normalizeLiveFeedPopupView(value);
  try {
    storage?.setItem(LIVE_FEED_POPUP_VIEW_STORAGE_KEY, normalized);
  } catch {
    // Browser privacy settings can deny durable storage; keep the in-memory choice.
  }
  return normalized;
}
