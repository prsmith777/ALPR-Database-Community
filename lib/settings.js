import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  writePrivateFile,
} from "./private-file.mjs";

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
  },
  homeassistant: {
    enabled: false,
    whitelist: [],
  },
  blueiris: {
    host: "Your Blue Iris Hostname or IP address",
  },
  privacy: {
    metrics: false,
  },
  training: {
    enabled: false,
    name: "",
  },
  agents: [
    {
      id: "default",
      title: "ALPR Agent",
      url: "http://localhost:8000/alt-alpr",
      enabled: true,
    },
  ],
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
    },
    homeassistant: {
      enabled: DEFAULT_CONFIG.homeassistant.enabled,
      whitelist: DEFAULT_CONFIG.homeassistant.whitelist,
    },
    blueiris: {
      host: env.BLUEIRIS_HOST || DEFAULT_CONFIG.blueiris.host,
    },
    privacy: {
      metrics: parseBooleanEnv(env.METRICS, DEFAULT_CONFIG.privacy.metrics),
    },
    training: {
      enabled: parseBooleanEnv(
        env.AI_TRAINING,
        DEFAULT_CONFIG.training.enabled
      ),
      name: DEFAULT_CONFIG.training.name,
    },
    agents: DEFAULT_CONFIG.agents,
  };
}

export function removeRuntimeDatabaseSecret(config, env = process.env) {
  const database = { ...(config.database || {}) };
  if (env.DB_PASSWORD) delete database.password;

  return {
    ...config,
    database,
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
      process.env.DB_PASSWORD &&
      Object.hasOwn(fileConfig.database || {}, "password")
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
      },
      homeassistant: {
        ...DEFAULT_CONFIG.homeassistant,
        ...fileConfig.homeassistant,
      },
      blueiris: {
        ...DEFAULT_CONFIG.blueiris,
        ...fileConfig.blueiris,
      },
      privacy: {
        ...DEFAULT_CONFIG.privacy,
        ...fileConfig.privacy,
      },
      training: {
        ...DEFAULT_CONFIG.training,
        ...fileConfig.training,
      },
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
      },
      homeassistant: {
        ...DEFAULT_CONFIG.homeassistant,
        ...newConfig.homeassistant,
      },
      blueiris: {
        ...DEFAULT_CONFIG.blueiris,
        ...newConfig.blueiris,
      },
      privacy: {
        ...DEFAULT_CONFIG.privacy,
        ...newConfig.privacy,
      },
      training: {
        ...DEFAULT_CONFIG.training,
        ...newConfig.training,
      },
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

export async function getAgents() {
  const config = await getConfig();
  return config.agents || DEFAULT_CONFIG.agents;
}
