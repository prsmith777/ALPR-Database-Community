export const SYSTEM_ROLES = Object.freeze([
  "administrator",
  "operator",
  "viewer",
  "auditor",
]);

export const PERMISSION_KEYS = Object.freeze([
  "system.manage_users",
  "system.manage_settings",
  "system.view_audit",
  "plate.read",
  "plate.review",
  "plate.delete",
  "known_plate.manage",
  "tag.manage",
  "notification.manage",
  "mqtt.manage",
  "export.create",
  "maintenance.manage",
]);

const ROLE_PERMISSION_SOURCE = {
  administrator: PERMISSION_KEYS,
  operator: [
    "plate.read",
    "plate.review",
    "plate.delete",
    "known_plate.manage",
    "tag.manage",
    "notification.manage",
    "mqtt.manage",
    "export.create",
  ],
  viewer: ["plate.read", "export.create"],
  auditor: ["plate.read", "system.view_audit", "export.create"],
};

export const ROLE_PERMISSIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(ROLE_PERMISSION_SOURCE).map(([role, permissions]) => [
      role,
      Object.freeze([...permissions]),
    ])
  )
);

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;

export function normalizeUsername(value) {
  const username = String(value ?? "").trim().toLowerCase();

  if (!USERNAME_PATTERN.test(username)) {
    throw new TypeError(
      "Username must be 3-64 characters and use lowercase letters, numbers, dots, underscores, or hyphens."
    );
  }

  return username;
}

export function isSystemRole(value) {
  return SYSTEM_ROLES.includes(String(value ?? "").trim().toLowerCase());
}

export function isPermissionKey(value) {
  return PERMISSION_KEYS.includes(String(value ?? "").trim());
}

export function permissionsForRole(role) {
  const normalized = String(role ?? "").trim().toLowerCase();
  const permissions = ROLE_PERMISSIONS[normalized];

  if (!permissions) {
    throw new TypeError("Unknown system role.");
  }

  return [...permissions];
}
