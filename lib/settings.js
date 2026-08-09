import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  writePrivateFile,
} from "./private-file.mjs";
import {
  DEFAULT_PLATE_MATCHING_SETTINGS,
  normalizePlateMatchingSettings,
} from "./plate-matching.mjs";
import {
  DEFAULT_VISUAL_INDEX_SETTINGS,
  normalizeVisualIndexSettings,
} from "./visual-index-settings.mjs";

const CONFIG_FILE = path.join(process.cwd(), "config", "settings.yaml");

const DEFAULT_CONFIG = {
  general: {
    maxRecords: 100000,
    ignoreNonPlate: false,
    timeFormat: 12,
    retention: 3,
  },
  mqtt: {
    broker: "",
    topic: "alpr/plates",
  },
  database: {
    host: "db:5432",
    name: "postgres",
    user: "postgres",
    password: "password",
  },
  notifications: {
    pushover: {
      enabled: false,
      app_token: "",
      user_key: "",
      priority: 1,
      sound: "pushover", // Default Pushover sound
      title: "ALPR Alert",
    },
    email: {
      enabled: false,
      host: "",
      port: 587,
      secure: false,
      verify_tls: true,
      username: "",
      password: "",
      from_address: "",
      from_name: "ALPR Database",
    },
    webhook: {
      enabled: false,
      signing_secret: "",
      timeout_seconds: 10,
      allow_http: false,
      allow_private_networks: false,
    },
  },
  homeassistant: {
    enabled: false,
    whitelist: [],
  },
  blueiris: {
    host: "Your Blue Iris Hostname or IP address",
    username: "",
    password: "",
    timeout_seconds: 10,
    timeline_export_profile: 0,
    timeline_export_min_width: 1920,
    timeline_export_min_height: 1080,
  },
  plateMatching: DEFAULT_PLATE_MATCHING_SETTINGS,
  visualIndex: DEFAULT_VISUAL_INDEX_SETTINGS,
  agents: [],
};

export function parseBooleanEnv(value, fallback = false) {
  if (typeof value !== "string") return fallback;

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;

  return fallback;
}

export function getDatabaseConfig(storedConfig = {}, env = process.env) {
  return {
    ...DEFAULT_CONFIG.database,
    ...storedConfig,
    ...(env.DB_HOST ? { host: env.DB_HOST } : {}),
    ...(env.DB_NAME ? { name: env.DB_NAME } : {}),
    ...(env.DB_USER ? { user: env.DB_USER } : {}),
    ...(env.DB_PASSWORD ? { password: env.DB_PASSWORD } : {}),
  };
}

export function getBlueIrisConfig(storedConfig = {}, env = process.env) {
  return {
    ...DEFAULT_CONFIG.blueiris,
    ...storedConfig,
    ...(env.BLUEIRIS_HOST ? { host: env.BLUEIRIS_HOST } : {}),
    ...(env.BLUEIRIS_USERNAME ? { username: env.BLUEIRIS_USERNAME } : {}),
    ...(env.BLUEIRIS_PASSWORD ? { password: env.BLUEIRIS_PASSWORD } : {}),
    ...(env.BLUEIRIS_TIMEOUT_SECONDS
      ? { timeout_seconds: parseInt(env.BLUEIRIS_TIMEOUT_SECONDS) }
      : {}),
    ...(env.BLUEIRIS_TIMELINE_EXPORT_PROFILE
      ? { timeline_export_profile: parseInt(env.BLUEIRIS_TIMELINE_EXPORT_PROFILE) }
      : {}),
    ...(env.BLUEIRIS_TIMELINE_EXPORT_MIN_WIDTH
      ? { timeline_export_min_width: parseInt(env.BLUEIRIS_TIMELINE_EXPORT_MIN_WIDTH) }
      : {}),
    ...(env.BLUEIRIS_TIMELINE_EXPORT_MIN_HEIGHT
      ? { timeline_export_min_height: parseInt(env.BLUEIRIS_TIMELINE_EXPORT_MIN_HEIGHT) }
      : {}),
  };
}

export function getInitialEnvConfig(env = process.env) {
  return {
    general: {
      maxRecords: env.MAX_RECORDS
        ? parseInt(env.MAX_RECORDS)
        : DEFAULT_CONFIG.general.maxRecords,
      ignoreNonPlate: parseBooleanEnv(
        env.IGNORE_NON_PLATE,
        DEFAULT_CONFIG.general.ignoreNonPlate
      ),
      timeFormat: DEFAULT_CONFIG.general.timeFormat,
      retention: DEFAULT_CONFIG.general.retention,
    },
    mqtt: {
      broker: env.MQTT_BROKER || DEFAULT_CONFIG.mqtt.broker,
      topic: env.MQTT_TOPIC || DEFAULT_CONFIG.mqtt.topic,
    },
    database: getDatabaseConfig({}, env),
    notifications: {
      pushover: {
        enabled: parseBooleanEnv(
          env.PUSHOVER_ENABLED,
          DEFAULT_CONFIG.notifications.pushover.enabled
        ),
        app_token:
          env.PUSHOVER_APP_TOKEN ||
          DEFAULT_CONFIG.notifications.pushover.app_token,
        user_key:
          env.PUSHOVER_USER_KEY ||
          DEFAULT_CONFIG.notifications.pushover.user_key,
        priority: env.PUSHOVER_PRIORITY
          ? parseInt(env.PUSHOVER_PRIORITY)
          : DEFAULT_CONFIG.notifications.pushover.priority,
        sound:
          env.PUSHOVER_SOUND || DEFAULT_CONFIG.notifications.pushover.sound,
        title:
          env.PUSHOVER_TITLE || DEFAULT_CONFIG.notifications.pushover.title,
      },
      email: {
        enabled: parseBooleanEnv(env.SMTP_ENABLED, DEFAULT_CONFIG.notifications.email.enabled),
        host: env.SMTP_HOST || DEFAULT_CONFIG.notifications.email.host,
        port: env.SMTP_PORT ? parseInt(env.SMTP_PORT) : DEFAULT_CONFIG.notifications.email.port,
        secure: parseBooleanEnv(env.SMTP_SECURE, DEFAULT_CONFIG.notifications.email.secure),
        verify_tls: parseBooleanEnv(env.SMTP_VERIFY_TLS, DEFAULT_CONFIG.notifications.email.verify_tls),
        username: env.SMTP_USERNAME || DEFAULT_CONFIG.notifications.email.username,
        password: env.SMTP_PASSWORD || DEFAULT_CONFIG.notifications.email.password,
        from_address: env.SMTP_FROM_ADDRESS || DEFAULT_CONFIG.notifications.email.from_address,
        from_name: env.SMTP_FROM_NAME || DEFAULT_CONFIG.notifications.email.from_name,
      },
      webhook: {
        enabled: parseBooleanEnv(env.WEBHOOK_ENABLED, DEFAULT_CONFIG.notifications.webhook.enabled),
        signing_secret: env.WEBHOOK_SIGNING_SECRET || DEFAULT_CONFIG.notifications.webhook.signing_secret,
        timeout_seconds: env.WEBHOOK_TIMEOUT_SECONDS
          ? parseInt(env.WEBHOOK_TIMEOUT_SECONDS)
          : DEFAULT_CONFIG.notifications.webhook.timeout_seconds,
        allow_http: parseBooleanEnv(env.WEBHOOK_ALLOW_HTTP, DEFAULT_CONFIG.notifications.webhook.allow_http),
        allow_private_networks: parseBooleanEnv(
          env.WEBHOOK_ALLOW_PRIVATE_NETWORKS,
          DEFAULT_CONFIG.notifications.webhook.allow_private_networks
        ),
      },
    },
    homeassistant: {
      enabled: DEFAULT_CONFIG.homeassistant.enabled,
      whitelist: DEFAULT_CONFIG.homeassistant.whitelist,
    },
    blueiris: getBlueIrisConfig({}, env),
    plateMatching: normalizePlateMatchingSettings(),
    visualIndex: normalizeVisualIndexSettings({
      enabled: parseBooleanEnv(
        env.VISUAL_INDEX_ENABLED,
        DEFAULT_VISUAL_INDEX_SETTINGS.enabled
      ),
      paused: parseBooleanEnv(
        env.VISUAL_INDEX_PAUSED,
        DEFAULT_VISUAL_INDEX_SETTINGS.paused
      ),
      batchSize: env.VISUAL_INDEX_BATCH_SIZE,
      intervalSeconds: env.VISUAL_INDEX_INTERVAL_SECONDS,
      minimumFreeDiskGb: env.VISUAL_INDEX_MINIMUM_FREE_DISK_GB,
      maximumLoadPercent: env.VISUAL_INDEX_MAXIMUM_LOAD_PERCENT,
    }),
    agents: DEFAULT_CONFIG.agents,
  };
}

export function removeRuntimeDatabaseSecret(config, env = process.env) {
  const database = { ...(config.database || {}) };
  if (env.DB_PASSWORD) delete database.password;
  const blueiris = { ...(config.blueiris || {}) };
  if (env.BLUEIRIS_PASSWORD) delete blueiris.password;

  return {
    ...config,
    database,
    blueiris,
  };
}

async function ensureConfigDir() {
  const configDir = path.dirname(CONFIG_FILE);
  await ensurePrivateDirectory(configDir);
}

async function readConfigFile() {
  try {
    await ensureConfigDir();
    await hardenPrivateFile(CONFIG_FILE);
    const fileContents = await fs.readFile(CONFIG_FILE, "utf8");
    // console.log("Reading config file:", fileContents);
    const config = yaml.load(fileContents);
    // console.log("Parsed config:", config);
    return config;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("No config file found");
      return null;
    }
    throw error;
  }
}

async function initializeConfigFile() {
  console.log("Initializing config file with environment values");
  const initialConfig = getInitialEnvConfig();
  const yamlString = yaml.dump(removeRuntimeDatabaseSecret(initialConfig));
  await ensureConfigDir();
  await writePrivateFile(CONFIG_FILE, yamlString);
  return initialConfig;
}

export async function getConfig() {
  try {
    let fileConfig = await readConfigFile();

    // If no config file exists, initialize it with environment/default values
    if (!fileConfig) {
      console.log("Creating initial config file from environment variables");
      fileConfig = await initializeConfigFile();
      return fileConfig;
    }

    if (
      (process.env.DB_PASSWORD &&
        Object.hasOwn(fileConfig.database || {}, "password")) ||
      (process.env.BLUEIRIS_PASSWORD &&
        Object.hasOwn(fileConfig.blueiris || {}, "password"))
    ) {
      fileConfig = removeRuntimeDatabaseSecret(fileConfig);
      await writePrivateFile(CONFIG_FILE, yaml.dump(fileConfig));
    }

    // If config file exists, use it with defaults as fallback
    const finalConfig = {
      general: { ...DEFAULT_CONFIG.general, ...fileConfig.general },
      mqtt: { ...DEFAULT_CONFIG.mqtt, ...fileConfig.mqtt },
      database: getDatabaseConfig(fileConfig.database),
      notifications: {
        pushover: {
          ...DEFAULT_CONFIG.notifications.pushover,
          ...fileConfig.notifications?.pushover,
        },
        email: {
          ...DEFAULT_CONFIG.notifications.email,
          ...fileConfig.notifications?.email,
        },
        webhook: {
          ...DEFAULT_CONFIG.notifications.webhook,
          ...fileConfig.notifications?.webhook,
        },
      },
      homeassistant: {
        ...DEFAULT_CONFIG.homeassistant,
        ...fileConfig.homeassistant,
      },
      blueiris: getBlueIrisConfig(fileConfig.blueiris),
      plateMatching: normalizePlateMatchingSettings(fileConfig.plateMatching),
      visualIndex: normalizeVisualIndexSettings(fileConfig.visualIndex),
      agents: fileConfig.agents || DEFAULT_CONFIG.agents,
    };

    // console.log("Using existing config file:", finalConfig);
    return finalConfig;
  } catch (error) {
    console.error("Error reading config:", error);
    return getInitialEnvConfig(); // Fallback to env/defaults only on error
  }
}

export async function isFirstRun() {
  try {
    await fs.access(CONFIG_FILE);
    return false;
  } catch {
    return true;
  }
}

export async function saveConfig(newConfig) {
  try {
    // Ensure all required fields exist by merging with defaults
    const configToSave = {
      general: {
        ...DEFAULT_CONFIG.general,
        ...newConfig.general,
      },
      mqtt: {
        ...DEFAULT_CONFIG.mqtt,
        ...newConfig.mqtt,
      },
      database: {
        ...DEFAULT_CONFIG.database,
        ...newConfig.database,
      },
      notifications: {
        pushover: {
          ...DEFAULT_CONFIG.notifications.pushover,
          ...newConfig.notifications?.pushover,
        },
        email: {
          ...DEFAULT_CONFIG.notifications.email,
          ...newConfig.notifications?.email,
        },
        webhook: {
          ...DEFAULT_CONFIG.notifications.webhook,
          ...newConfig.notifications?.webhook,
        },
      },
      homeassistant: {
        ...DEFAULT_CONFIG.homeassistant,
        ...newConfig.homeassistant,
      },
      blueiris: {
        ...DEFAULT_CONFIG.blueiris,
        ...newConfig.blueiris,
      },
      plateMatching: normalizePlateMatchingSettings(newConfig.plateMatching),
      visualIndex: normalizeVisualIndexSettings(newConfig.visualIndex),
      agents: newConfig.agents || DEFAULT_CONFIG.agents,
    };

    await ensureConfigDir();
    const yamlString = yaml.dump(removeRuntimeDatabaseSecret(configToSave));
    await writePrivateFile(CONFIG_FILE, yamlString);

    return { success: true, data: configToSave };
  } catch (error) {
    console.error("Error saving config:", error);
    return { success: false, error: "Failed to save configuration" };
  }
}

function isRetiredPlaceholderAgent(agent) {
  return (
    ["default", "test-agent"].includes(String(agent?.id || "")) &&
    String(agent?.url || "") === "http://localhost:8000/alt-alpr"
  );
}

export async function getAgents() {
  const config = await getConfig();
  return (config.agents || DEFAULT_CONFIG.agents).filter(
    (agent) => agent?.enabled && !isRetiredPlaceholderAgent(agent)
  );
}
