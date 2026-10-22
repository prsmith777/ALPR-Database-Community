import { normalizePlateValue } from "./plate-review-repository.mjs";

export function normalizeStateCountry(value) {
  if (typeof value !== "string" || value.length > 100 || /[\x00-\x1f\x7f]/u.test(value)) {
    throw Object.assign(new Error("State/Country must be text of at most 100 characters without control characters."), { code: "INVALID_STATE_COUNTRY" });
  }
  return value.trim() || null;
}

export async function listPlateStateCountries(getPool) {
  const pool = await getPool();
  const result = await pool.query(
    "SELECT DISTINCT ON (LOWER(state_country)) state_country FROM public.plates " +
    "WHERE NULLIF(BTRIM(state_country), '') IS NOT NULL ORDER BY LOWER(state_country), state_country"
  );
  return result.rows.map((row) => row.state_country);
}

export async function savePlateStateCountry(getPool, { plateNumber, stateCountry, actor }) {
  const plate = normalizePlateValue(plateNumber);
  const value = normalizeStateCountry(stateCountry);
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query("SELECT state_country FROM public.plates WHERE plate_number = $1 FOR UPDATE", [plate]);
    if (!selected.rows.length) throw Object.assign(new Error("Plate was not found."), { code: "PLATE_NOT_FOUND" });
    const previous = selected.rows[0].state_country;
    if (previous !== value) {
      await client.query("UPDATE public.plates SET state_country = $2 WHERE plate_number = $1", [plate, value]);
      await client.query(
        "INSERT INTO public.audit_events (actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata) " +
        "VALUES ($1::bigint, 'browser', 'plate.state_country.updated', 'plate', $2, 'succeeded', $3::jsonb)",
        [actor?.id || null, plate, JSON.stringify({ previous, stateCountry: value })]
      );
    }
    await client.query("COMMIT");
    return { plate_number: plate, state_country: value };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
