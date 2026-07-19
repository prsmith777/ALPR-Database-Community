function repositoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mapUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    status: row.status,
    roles: row.roles || [],
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export class PostgresIdentityRepository {
  constructor({ getPool }) {
    if (typeof getPool !== "function") {
      throw new TypeError("A PostgreSQL pool provider is required.");
    }
    this.getPool = getPool;
  }

  async transaction(operation) {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getBootstrapState() {
    const pool = await this.getPool();
    const result = await pool.query(`
      SELECT
        COUNT(*)::integer AS user_count,
        COUNT(*) FILTER (WHERE status = 'active')::integer AS active_user_count
      FROM public.users
    `);
    return result.rows[0];
  }

  async bootstrapOwner({
    username,
    displayName,
    passwordHash,
    tokenHash,
    userAgent,
    expiresAt,
  }) {
    return await this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('alpr_identity_owner_bootstrap'))"
      );
      const count = await client.query(
        "SELECT COUNT(*)::integer AS count FROM public.users"
      );
      if (count.rows[0].count !== 0) {
        throw repositoryError(
          "IDENTITY_ALREADY_BOOTSTRAPPED",
          "A named administrator already exists."
        );
      }

      const inserted = await client.query(
        `
          INSERT INTO public.users (username, display_name, password_hash)
          VALUES ($1, $2, $3)
          RETURNING id, username, display_name, status, created_at, last_login_at
        `,
        [username, displayName, passwordHash]
      );
      const user = inserted.rows[0];

      await client.query(
        `
          INSERT INTO public.user_roles (user_id, role_id, granted_by_user_id)
          SELECT $1, id, $1
          FROM public.roles
          WHERE name = 'administrator'
        `,
        [user.id]
      );
      await client.query(
        `
          INSERT INTO public.user_sessions
            (user_id, token_hash, user_agent, expires_at)
          VALUES ($1, $2, $3, $4)
        `,
        [user.id, tokenHash, userAgent, expiresAt]
      );
      await client.query(
        `
          INSERT INTO public.audit_events
            (actor_user_id, source, event_type, resource_type, resource_id,
             outcome, metadata)
          VALUES ($1, 'browser', 'identity.owner_bootstrapped', 'user', $1::text,
                  'succeeded', $2::jsonb)
        `,
        [user.id, JSON.stringify({ username })]
      );

      return mapUser({ ...user, roles: ["administrator"] });
    });
  }

  async findUserByUsername(username) {
    const pool = await this.getPool();
    const result = await pool.query(
      `
        SELECT id, username, display_name, password_hash, status
        FROM public.users
        WHERE username = $1
        LIMIT 1
      `,
      [username]
    );
    return result.rows[0] || null;
  }

  async findUserById(userId) {
    const pool = await this.getPool();
    const result = await pool.query(
      `
        SELECT id, username, display_name, password_hash, status
        FROM public.users
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    );
    return result.rows[0] || null;
  }

  async recordFailedLogin(userId, username) {
    const pool = await this.getPool();
    await pool.query(
      `
        INSERT INTO public.audit_events
          (actor_user_id, source, event_type, resource_type, resource_id,
           outcome, reason, metadata)
        VALUES ($1, 'browser', 'auth.login', 'user', $2, 'denied',
                'invalid_credentials', $3::jsonb)
      `,
      [userId || null, userId ? String(userId) : null, JSON.stringify({ username })]
    );
  }

  async createSession({ userId, tokenHash, userAgent, expiresAt }) {
    return await this.transaction(async (client) => {
      await client.query(
        `
          DELETE FROM public.user_sessions
          WHERE user_id = $1
            AND (expires_at <= CURRENT_TIMESTAMP OR revoked_at IS NOT NULL)
        `,
        [userId]
      );
      const sessions = await client.query(
        `
          SELECT id
          FROM public.user_sessions
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY last_used_at ASC, id ASC
          FOR UPDATE
        `,
        [userId]
      );
      const removeCount = Math.max(0, sessions.rows.length - 4);
      if (removeCount > 0) {
        await client.query(
          `
            DELETE FROM public.user_sessions
            WHERE id = ANY($1::bigint[])
          `,
          [sessions.rows.slice(0, removeCount).map((row) => row.id)]
        );
      }
      await client.query(
        `
          INSERT INTO public.user_sessions
            (user_id, token_hash, user_agent, expires_at)
          VALUES ($1, $2, $3, $4)
        `,
        [userId, tokenHash, userAgent, expiresAt]
      );
      await client.query(
        "UPDATE public.users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1",
        [userId]
      );
      await client.query(
        `
          INSERT INTO public.audit_events
            (actor_user_id, source, event_type, resource_type, resource_id, outcome)
          VALUES ($1, 'browser', 'auth.login', 'user', $1::text, 'succeeded')
        `,
        [userId]
      );
    });
  }

  async getSessionPrincipal(tokenHash) {
    const pool = await this.getPool();
    const result = await pool.query(
      `
        SELECT
          session.id AS session_id,
          session.user_agent,
          session.created_at AS session_created_at,
          session.last_used_at,
          session.expires_at,
          app_user.id,
          app_user.username,
          app_user.display_name,
          COALESCE(
            array_agg(DISTINCT role.name) FILTER (WHERE role.name IS NOT NULL),
            ARRAY[]::varchar[]
          ) AS roles,
          COALESCE(
            array_agg(DISTINCT permission.permission_key)
              FILTER (WHERE permission.permission_key IS NOT NULL),
            ARRAY[]::varchar[]
          ) AS permissions
        FROM public.user_sessions AS session
        JOIN public.users AS app_user ON app_user.id = session.user_id
        LEFT JOIN public.user_roles AS user_role ON user_role.user_id = app_user.id
        LEFT JOIN public.roles AS role ON role.id = user_role.role_id
        LEFT JOIN public.role_permissions AS role_permission
          ON role_permission.role_id = role.id
        LEFT JOIN public.permissions AS permission
          ON permission.id = role_permission.permission_id
        WHERE session.token_hash = $1
          AND session.revoked_at IS NULL
          AND session.expires_at > CURRENT_TIMESTAMP
          AND app_user.status = 'active'
        GROUP BY session.id, app_user.id
        LIMIT 1
      `,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      username: row.username,
      displayName: row.display_name,
      roles: row.roles || [],
      permissions: row.permissions || [],
      authMode: "named",
      session: {
        id: Number(row.session_id),
        userAgent: row.user_agent,
        createdAt: row.session_created_at,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
      },
    };
  }

  async touchSession(sessionId) {
    const pool = await this.getPool();
    await pool.query(
      `
        UPDATE public.user_sessions
        SET last_used_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND last_used_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
      `,
      [sessionId]
    );
  }

  async revokeSession(tokenHash, reason = "logout") {
    const pool = await this.getPool();
    const result = await pool.query(
      `
        UPDATE public.user_sessions
        SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = $2
        WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING id
      `,
      [tokenHash, reason]
    );
    return result.rowCount > 0;
  }

  async listUsers() {
    const pool = await this.getPool();
    const result = await pool.query(`
      SELECT
        app_user.id,
        app_user.username,
        app_user.display_name,
        app_user.status,
        app_user.created_at,
        app_user.last_login_at,
        COALESCE(
          array_agg(DISTINCT role.name) FILTER (WHERE role.name IS NOT NULL),
          ARRAY[]::varchar[]
        ) AS roles
      FROM public.users AS app_user
      LEFT JOIN public.user_roles AS user_role ON user_role.user_id = app_user.id
      LEFT JOIN public.roles AS role ON role.id = user_role.role_id
      GROUP BY app_user.id
      ORDER BY app_user.username ASC
    `);
    return result.rows.map(mapUser);
  }

  async createUser({ actorUserId, username, displayName, passwordHash, roleName }) {
    return await this.transaction(async (client) => {
      const inserted = await client.query(
        `
          INSERT INTO public.users (username, display_name, password_hash)
          VALUES ($1, $2, $3)
          RETURNING id, username, display_name, status, created_at, last_login_at
        `,
        [username, displayName, passwordHash]
      );
      const user = inserted.rows[0];
      const role = await client.query(
        `
          INSERT INTO public.user_roles (user_id, role_id, granted_by_user_id)
          SELECT $1, id, $2 FROM public.roles WHERE name = $3
          RETURNING role_id
        `,
        [user.id, actorUserId, roleName]
      );
      if (role.rowCount !== 1) {
        throw repositoryError("UNKNOWN_ROLE", "The selected role does not exist.");
      }
      await client.query(
        `
          INSERT INTO public.audit_events
            (actor_user_id, source, event_type, resource_type, resource_id,
             outcome, metadata)
          VALUES ($1, 'browser', 'identity.user_created', 'user', $2::text,
                  'succeeded', $3::jsonb)
        `,
        [actorUserId, user.id, JSON.stringify({ username, role: roleName })]
      );
      return mapUser({ ...user, roles: [roleName] });
    });
  }

  async setUserStatus({ actorUserId, targetUserId, status }) {
    return await this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('alpr_identity_admin_guard'))"
      );
      if (actorUserId === targetUserId && status === "disabled") {
        throw repositoryError("CANNOT_DISABLE_SELF", "You cannot disable your own account.");
      }
      const target = await client.query(
        "SELECT id, username FROM public.users WHERE id = $1 FOR UPDATE",
        [targetUserId]
      );
      if (!target.rows[0]) throw repositoryError("USER_NOT_FOUND", "User not found.");
      const targetRole = await client.query(
        `
          SELECT EXISTS (
            SELECT 1
            FROM public.user_roles AS user_role
            JOIN public.roles AS role ON role.id = user_role.role_id
            WHERE user_role.user_id = $1 AND role.name = 'administrator'
          ) AS is_administrator
        `,
        [targetUserId]
      );
      if (status === "disabled" && targetRole.rows[0].is_administrator) {
        const administrators = await client.query(`
          SELECT COUNT(DISTINCT app_user.id)::integer AS count
          FROM public.users AS app_user
          JOIN public.user_roles AS user_role ON user_role.user_id = app_user.id
          JOIN public.roles AS role ON role.id = user_role.role_id
          WHERE app_user.status = 'active' AND role.name = 'administrator'
        `);
        if (administrators.rows[0].count <= 1) {
          throw repositoryError(
            "LAST_ADMINISTRATOR",
            "The last active administrator cannot be disabled."
          );
        }
      }
      await client.query("UPDATE public.users SET status = $2 WHERE id = $1", [
        targetUserId,
        status,
      ]);
      if (status === "disabled") {
        await client.query(
          `
            UPDATE public.user_sessions
            SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = 'account_disabled'
            WHERE user_id = $1 AND revoked_at IS NULL
          `,
          [targetUserId]
        );
      }
      await client.query(
        `
          INSERT INTO public.audit_events
            (actor_user_id, source, event_type, resource_type, resource_id,
             outcome, metadata)
          VALUES ($1, 'browser', 'identity.user_status_changed', 'user', $2::text,
                  'succeeded', $3::jsonb)
        `,
        [actorUserId, targetUserId, JSON.stringify({ status })]
      );
    });
  }

  async setUserRole({ actorUserId, targetUserId, roleName }) {
    return await this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('alpr_identity_admin_guard'))"
      );
      const current = await client.query(
        "SELECT id, status FROM public.users WHERE id = $1 FOR UPDATE",
        [targetUserId]
      );
      if (!current.rows[0]) throw repositoryError("USER_NOT_FOUND", "User not found.");
      const currentRole = await client.query(
        `
          SELECT EXISTS (
            SELECT 1
            FROM public.user_roles AS user_role
            JOIN public.roles AS role ON role.id = user_role.role_id
            WHERE user_role.user_id = $1 AND role.name = 'administrator'
          ) AS is_administrator
        `,
        [targetUserId]
      );
      if (
        current.rows[0].status === "active" &&
        currentRole.rows[0].is_administrator &&
        roleName !== "administrator"
      ) {
        const administrators = await client.query(`
          SELECT COUNT(DISTINCT app_user.id)::integer AS count
          FROM public.users AS app_user
          JOIN public.user_roles AS user_role ON user_role.user_id = app_user.id
          JOIN public.roles AS role ON role.id = user_role.role_id
          WHERE app_user.status = 'active' AND role.name = 'administrator'
        `);
        if (administrators.rows[0].count <= 1) {
          throw repositoryError(
            "LAST_ADMINISTRATOR",
            "The last active administrator must keep the administrator role."
          );
        }
      }
      const role = await client.query("SELECT id FROM public.roles WHERE name = $1", [
        roleName,
      ]);
      if (!role.rows[0]) throw repositoryError("UNKNOWN_ROLE", "Role not found.");
      await client.query("DELETE FROM public.user_roles WHERE user_id = $1", [targetUserId]);
      await client.query(
        `
          INSERT INTO public.user_roles (user_id, role_id, granted_by_user_id)
          VALUES ($1, $2, $3)
        `,
        [targetUserId, role.rows[0].id, actorUserId]
      );
      await client.query(
        `
          INSERT INTO public.audit_events
            (actor_user_id, source, event_type, resource_type, resource_id,
             outcome, metadata)
          VALUES ($1, 'browser', 'identity.user_role_changed', 'user', $2::text,
                  'succeeded', $3::jsonb)
        `,
        [actorUserId, targetUserId, JSON.stringify({ role: roleName })]
      );
    });
  }

  async updateUserPassword({ actorUserId, targetUserId, passwordHash, eventType }) {
    return await this.transaction(async (client) => {
      const result = await client.query(
        `
          UPDATE public.users
          SET password_hash = $2, password_changed_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING id
        `,
        [targetUserId, passwordHash]
      );
      if (result.rowCount !== 1) throw repositoryError("USER_NOT_FOUND", "User not found.");
      await client.query(
        `
          UPDATE public.user_sessions
          SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = 'password_changed'
          WHERE user_id = $1 AND revoked_at IS NULL
        `,
        [targetUserId]
      );
      await client.query(
        `
          INSERT INTO public.audit_events
            (actor_user_id, source, event_type, resource_type, resource_id, outcome)
          VALUES ($1, 'browser', $3, 'user', $2::text, 'succeeded')
        `,
        [actorUserId, targetUserId, eventType]
      );
    });
  }
}
