import crypto from "node:crypto";
import bcrypt from "bcrypt";

import {
  PERMISSION_KEYS,
  isPermissionKey,
  isSystemRole,
  normalizeUsername,
} from "./identity-model.mjs";

export const NAMED_SESSION_EXPIRATION_MS = 24 * 60 * 60 * 1000;
const PASSWORD_MINIMUM_LENGTH = 8;

export class IdentityInputError extends Error {
  constructor(message, code = "INVALID_IDENTITY_INPUT") {
    super(message);
    this.name = "IdentityInputError";
    this.code = code;
  }
}

function normalizeDisplayName(value) {
  const displayName = String(value ?? "").trim();
  if (displayName.length < 1 || displayName.length > 120) {
    throw new IdentityInputError("Display name must be between 1 and 120 characters.");
  }
  return displayName;
}

function validateUsername(value) {
  try {
    return normalizeUsername(value);
  } catch (error) {
    throw new IdentityInputError(error.message);
  }
}

function validatePassword(value) {
  const password = String(value ?? "");
  if (password.length < PASSWORD_MINIMUM_LENGTH) {
    throw new IdentityInputError("Password must be at least 8 characters long.");
  }
  return password;
}

function validateRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  if (!isSystemRole(role)) {
    throw new IdentityInputError("Select a valid role.");
  }
  return role;
}

function sanitizeUserAgent(value) {
  return String(value || "Unknown Device").slice(0, 255);
}

export function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function hasPermission(principal, permission) {
  if (!isPermissionKey(permission)) return false;
  return Boolean(principal?.permissions?.includes(permission));
}

export function legacyAdministratorPrincipal(session = null) {
  return {
    id: null,
    username: "admin",
    displayName: "Legacy Administrator",
    roles: ["administrator"],
    permissions: [...PERMISSION_KEYS],
    authMode: "legacy",
    session,
  };
}

export class IdentityService {
  constructor({
    repository,
    passwordHasher = (password) => bcrypt.hash(password, 10),
    passwordVerifier = (password, hash) => bcrypt.compare(password, hash),
    randomToken = () => crypto.randomBytes(32).toString("hex"),
    now = () => new Date(),
  }) {
    if (!repository) throw new TypeError("An identity repository is required.");
    this.repository = repository;
    this.passwordHasher = passwordHasher;
    this.passwordVerifier = passwordVerifier;
    this.randomToken = randomToken;
    this.now = now;
  }

  createSessionMaterial() {
    const token = this.randomToken();
    return {
      token,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(this.now().getTime() + NAMED_SESSION_EXPIRATION_MS),
    };
  }

  async getBootstrapState() {
    const state = await this.repository.getBootstrapState();
    return {
      userCount: Number(state.user_count || 0),
      activeUserCount: Number(state.active_user_count || 0),
      bootstrapped: Number(state.user_count || 0) > 0,
    };
  }

  async bootstrapOwner({ username, displayName, password, userAgent }) {
    const normalizedUsername = validateUsername(username);
    const normalizedDisplayName = normalizeDisplayName(displayName);
    const validPassword = validatePassword(password);
    const passwordHash = await this.passwordHasher(validPassword);
    const session = this.createSessionMaterial();
    const user = await this.repository.bootstrapOwner({
      username: normalizedUsername,
      displayName: normalizedDisplayName,
      passwordHash,
      tokenHash: session.tokenHash,
      userAgent: sanitizeUserAgent(userAgent),
      expiresAt: session.expiresAt,
    });
    return { user, sessionToken: session.token };
  }

  async authenticate({ username, password, userAgent }) {
    let normalizedUsername;
    try {
      normalizedUsername = validateUsername(username);
    } catch {
      return null;
    }
    const user = await this.repository.findUserByUsername(normalizedUsername);
    const valid = Boolean(
      user &&
        user.status === "active" &&
        password &&
        (await this.passwordVerifier(String(password), user.password_hash))
    );
    if (!valid) {
      await this.repository.recordFailedLogin(user?.id || null, normalizedUsername);
      return null;
    }
    const session = this.createSessionMaterial();
    await this.repository.createSession({
      userId: user.id,
      tokenHash: session.tokenHash,
      userAgent: sanitizeUserAgent(userAgent),
      expiresAt: session.expiresAt,
    });
    return { sessionToken: session.token };
  }

  async getSessionPrincipal(token) {
    if (!/^[0-9a-f]{64}$/.test(String(token || ""))) return null;
    const principal = await this.repository.getSessionPrincipal(hashSessionToken(token));
    if (!principal) return null;
    await this.repository.touchSession(principal.session.id);
    return principal;
  }

  async revokeSession(token, reason = "logout") {
    if (!/^[0-9a-f]{64}$/.test(String(token || ""))) return false;
    return await this.repository.revokeSession(hashSessionToken(token), reason);
  }

  async listUsers() {
    return await this.repository.listUsers();
  }

  async createUser({ actor, username, displayName, password, role }) {
    if (!actor?.id) throw new IdentityInputError("A named administrator is required.");
    const passwordHash = await this.passwordHasher(validatePassword(password));
    return await this.repository.createUser({
      actorUserId: actor.id,
      username: validateUsername(username),
      displayName: normalizeDisplayName(displayName),
      passwordHash,
      roleName: validateRole(role),
    });
  }

  async setUserStatus({ actor, userId, status }) {
    if (!actor?.id) throw new IdentityInputError("A named administrator is required.");
    const normalizedStatus = String(status || "").toLowerCase();
    if (!["active", "disabled"].includes(normalizedStatus)) {
      throw new IdentityInputError("Select a valid account status.");
    }
    await this.repository.setUserStatus({
      actorUserId: actor.id,
      targetUserId: Number(userId),
      status: normalizedStatus,
    });
  }

  async setUserRole({ actor, userId, role }) {
    if (!actor?.id) throw new IdentityInputError("A named administrator is required.");
    await this.repository.setUserRole({
      actorUserId: actor.id,
      targetUserId: Number(userId),
      roleName: validateRole(role),
    });
  }

  async resetUserPassword({ actor, userId, password, currentPassword }) {
    if (!actor?.id) throw new IdentityInputError("A named administrator is required.");
    const targetUserId = Number(userId);
    if (targetUserId === actor.id) {
      throw new IdentityInputError(
        "Use Change Password to update your own password.",
        "CANNOT_RESET_SELF"
      );
    }
    const administrator = await this.repository.findUserById(actor.id);
    if (
      !administrator ||
      !(await this.passwordVerifier(
        String(currentPassword || ""),
        administrator.password_hash
      ))
    ) {
      throw new IdentityInputError(
        "Incorrect administrator password.",
        "INVALID_PASSWORD"
      );
    }
    await this.repository.updateUserPassword({
      actorUserId: actor.id,
      targetUserId,
      passwordHash: await this.passwordHasher(validatePassword(password)),
      eventType: "identity.user_password_reset",
    });
  }

  async deleteUser({ actor, userId, confirmUsername, currentPassword }) {
    if (!actor?.id) throw new IdentityInputError("A named administrator is required.");
    const targetUserId = Number(userId);
    if (targetUserId === actor.id) {
      throw new IdentityInputError(
        "You cannot delete your own account.",
        "CANNOT_DELETE_SELF"
      );
    }
    const administrator = await this.repository.findUserById(actor.id);
    if (
      !administrator ||
      !(await this.passwordVerifier(
        String(currentPassword || ""),
        administrator.password_hash
      ))
    ) {
      throw new IdentityInputError(
        "Incorrect administrator password.",
        "INVALID_PASSWORD"
      );
    }
    await this.repository.deleteUser({
      actorUserId: actor.id,
      targetUserId,
      confirmUsername: String(confirmUsername || "").trim().toLowerCase(),
      deletedPasswordHash: await this.passwordHasher(this.randomToken()),
    });
  }

  async changeOwnPassword({ actor, currentPassword, newPassword }) {
    if (!actor?.id) throw new IdentityInputError("A named account is required.");
    const user = await this.repository.findUserById(actor.id);
    if (
      !user ||
      !(await this.passwordVerifier(String(currentPassword || ""), user.password_hash))
    ) {
      throw new IdentityInputError("Incorrect current password.", "INVALID_PASSWORD");
    }
    await this.repository.updateUserPassword({
      actorUserId: actor.id,
      targetUserId: actor.id,
      passwordHash: await this.passwordHasher(validatePassword(newPassword)),
      eventType: "identity.password_changed",
    });
  }
}
