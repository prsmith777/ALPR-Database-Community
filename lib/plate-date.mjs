export function formatPlateDateTime(timestamp, timeFormat = 12) {
  if (timestamp === null || timestamp === undefined || timestamp === "") {
    return "—";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return date.toLocaleString(timeFormat == 24 ? "en-GB" : "en-US");
}
