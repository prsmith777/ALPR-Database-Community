import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const DISPLAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = value => createHash("sha256").update(value).digest("hex");
const validToken = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export const displayHeaders = Object.freeze({
  "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
});

export function normalizeDisplayGrant(input = {}) {
  const label = String(input.label || "").trim();
  let origin;
  try { origin = new URL(String(input.allowedOrigin || "").trim()); } catch { throw new Error("Enter the full Home Assistant origin, including http:// or https:// and its port."); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== "/" || origin.search || origin.hash || origin.origin === "null")
    throw new Error("Use an exact Home Assistant origin with no path, credentials, query or fragment.");
  const host = origin.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(host) && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host))
    throw new Error("Use one exact Home Assistant host; wildcards and policy expressions are not allowed.");
  if (!label || label.length > 80) throw new Error("Enter a display name of up to 80 characters.");
  const days = Number(input.days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Choose an expiration of 1 to 90 days.");
  const cameraName = String(input.cameraName || "").trim();
  if (cameraName.length > 100) throw new Error("Invalid camera selection.");
  return { label, allowedOrigin: origin.origin, days, cameraName: cameraName || null };
}

export class HomeAssistantDisplayService {
  constructor(pool, { now = () => Date.now() } = {}) { this.pool = pool; this.now = now; }
  async list() {
    const result = await this.pool.query(`SELECT id, label, allowed_origin, camera_name, created_at, expires_at, revoked_at
      FROM public.home_assistant_display_grants ORDER BY created_at DESC LIMIT 100`);
    return result.rows;
  }
  async create(input, actor) {
    const value = normalizeDisplayGrant(input);
    if (value.cameraName) {
      const camera = await this.pool.query("SELECT 1 FROM public.plate_reads WHERE camera_name = $1 LIMIT 1", [value.cameraName]);
      if (!camera.rows.length) throw new Error("Choose a camera with ALPR read history.");
    }
    const id = randomUUID(), token = randomBytes(32).toString("base64url");
    const expires = new Date(this.now() + value.days * 86_400_000);
    await this.pool.query(`INSERT INTO public.home_assistant_display_grants
      (id,label,token_hash,allowed_origin,camera_name,created_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, value.label, digest(token), value.allowedOrigin, value.cameraName, String(actor?.username || "administrator").slice(0,100), expires]);
    return { id, token, expiresAt: expires.toISOString() };
  }
  async revoke(id) {
    if (!DISPLAY_ID.test(id || "")) throw new Error("Invalid display.");
    await this.pool.query("UPDATE public.home_assistant_display_grants SET revoked_at = COALESCE(revoked_at,CURRENT_TIMESTAMP) WHERE id = $1", [id]);
  }
  async publicGrant(id) {
    if (!DISPLAY_ID.test(id || "")) return null;
    const result = await this.pool.query(`SELECT id, allowed_origin FROM public.home_assistant_display_grants
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`, [id]);
    return result.rows[0] || null;
  }
  async authorize(id, authorization) {
    if (!DISPLAY_ID.test(id || "")) return null;
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization || "")?.[1];
    if (!validToken(token)) return null;
    const result = await this.pool.query(`SELECT id, label, camera_name, token_hash FROM public.home_assistant_display_grants
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`, [id]);
    const grant = result.rows[0];
    if (!grant || !/^[0-9a-f]{64}$/.test(grant.token_hash || "")) return null;
    if (!timingSafeEqual(Buffer.from(digest(token), "hex"), Buffer.from(grant.token_hash, "hex"))) return null;
    return { id: grant.id, label: grant.label, cameraName: grant.camera_name };
  }
  async reads(grant) {
    const result = await this.pool.query(`SELECT id, plate_number, camera_name, timestamp,
      bi_trigger_direction_label AS direction,
      (vehicle_image_path IS NOT NULL OR image_path IS NOT NULL) AS has_image
      FROM public.plate_reads WHERE ($1::text IS NULL OR camera_name = $1)
        AND timestamp > CURRENT_TIMESTAMP - INTERVAL '24 hours'
      ORDER BY timestamp DESC, id DESC LIMIT 25`, [grant.cameraName]);
    return { label: grant.label, reads: result.rows };
  }
  async imagePath(grant, readId) {
    if (!/^[1-9]\d{0,9}$/.test(String(readId || ""))) return null;
    const result = await this.pool.query(`SELECT COALESCE(vehicle_image_path,image_path) AS path
      FROM public.plate_reads WHERE id = $1 AND ($2::text IS NULL OR camera_name = $2)
        AND timestamp > CURRENT_TIMESTAMP - INTERVAL '24 hours'`, [readId, grant.cameraName]);
    return result.rows[0]?.path || null;
  }
}

// An explicit credential is required for every request. Display credentials are
// never accepted by browser session verification, general images, or mutations.
export function createDisplayReadHandler({ service, readImage }) {
  return async (request, { params }) => {
    try {
      const { grantId, readId } = await params;
      const grant = await service.authorize(grantId, request.headers.get("authorization"));
      if (!grant) return Response.json({ error: "Display access expired, revoked or invalid." }, { status: 401, headers: displayHeaders });
      if (readId !== undefined) {
        const path = await service.imagePath(grant, readId);
        const image = path ? await readImage(path) : null;
        return new Response(image, { status: image ? 200 : 404, headers: { ...displayHeaders, "Content-Type": "image/jpeg" } });
      }
      return Response.json(await service.reads(grant), { headers: displayHeaders });
    } catch {
      return Response.json({ error: "Display temporarily unavailable." }, { status: 503, headers: displayHeaders });
    }
  };
}
