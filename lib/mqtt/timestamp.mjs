const ISO_WITH_TIMEZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const NUMERIC_TIMESTAMP = /^\d{10}(?:\d{3})?$/;
const US_LOCAL_TIMESTAMP = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(AM|PM)?$/i;
const ISO_LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeMilliseconds(value = "") {
  return Number(String(value).padEnd(3, "0").slice(0, 3)) || 0;
}

function parseUsLocalTimestamp(value) {
  const match = String(value).trim().match(US_LOCAL_TIMESTAMP);
  if (!match) return null;

  let hour = Number(match[4]);
  const meridiem = match[8]?.toUpperCase();

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem === "PM") hour += 12;
  }

  return {
    year: Number(match[3]),
    month: Number(match[1]),
    day: Number(match[2]),
    hour,
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    millisecond: normalizeMilliseconds(match[7]),
  };
}

function parseIsoLocalTimestamp(value) {
  const match = String(value).trim().match(ISO_LOCAL_TIMESTAMP);
  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    millisecond: normalizeMilliseconds(match[7]),
  };
}

function areValidDateParts(parts) {
  if (!parts) return false;

  const candidate = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      parts.millisecond
    )
  );

  return (
    candidate.getUTCFullYear() === parts.year &&
    candidate.getUTCMonth() === parts.month - 1 &&
    candidate.getUTCDate() === parts.day &&
    candidate.getUTCHours() === parts.hour &&
    candidate.getUTCMinutes() === parts.minute &&
    candidate.getUTCSeconds() === parts.second
  );
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

/**
 * Convert a timezone-free wall clock into a UTC Date without depending on the
 * Docker container timezone. Two correction passes handle normal DST offsets.
 */
function zonedDatePartsToUtc(parts, timeZone) {
  const desiredWallClock = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond
  );

  let utcGuess = desiredWallClock;

  for (let pass = 0; pass < 3; pass += 1) {
    const zoned = getZonedParts(new Date(utcGuess), timeZone);
    const representedWallClock = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
      parts.millisecond
    );
    const correction = desiredWallClock - representedWallClock;
    utcGuess += correction;
    if (correction === 0) break;
  }

  return new Date(utcGuess);
}

function parseTimestamp(value, timeZone) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { date: new Date(value.getTime()), inputHadTimezone: true };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime())
      ? null
      : { date, inputHadTimezone: true };
  }

  const text = String(value ?? "").trim();
  if (!text) return null;

  if (NUMERIC_TIMESTAMP.test(text)) {
    const numeric = Number(text);
    const milliseconds = text.length === 10 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime())
      ? null
      : { date, inputHadTimezone: true };
  }

  if (ISO_WITH_TIMEZONE.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime())
      ? null
      : { date, inputHadTimezone: true };
  }

  const localParts = parseUsLocalTimestamp(text) ?? parseIsoLocalTimestamp(text);
  if (!areValidDateParts(localParts)) return null;

  return {
    date: zonedDatePartsToUtc(localParts, timeZone),
    inputHadTimezone: false,
  };
}

export function formatLocalTimestamp(date, timeZone, { hour12 = true } = {}) {
  const includeMilliseconds = date.getUTCMilliseconds() !== 0;

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    ...(includeMilliseconds ? { fractionalSecondDigits: 3 } : {}),
    hour12,
  }).format(date);
}

export function normalizeTimestamp(
  value,
  {
    timeZone = "UTC",
    hour12 = true,
    now = () => new Date(),
  } = {}
) {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Invalid IANA timezone: ${timeZone}`);
  }

  const parsed = parseTimestamp(value, timeZone);
  const fallbackDate = now();
  const date = parsed?.date ?? fallbackDate;

  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error("Timestamp fallback did not return a valid Date");
  }

  return {
    timestamp: date.toISOString(),
    timestampLocal: formatLocalTimestamp(date, timeZone, { hour12 }),
    timestampEpoch: date.getTime(),
    source: parsed ? "provided" : "server-receipt-fallback",
    inputHadTimezone: parsed?.inputHadTimezone ?? false,
  };
}
