// lib/notifications.js
import { getConfig } from "@/lib/settings";

// Cache for config to avoid repeated disk reads
let configCache = null;
let configLastLoaded = 0;
const CONFIG_CACHE_TTL = 60000; // 1 minute cache

async function getPushoverConfig() {
  // Refresh cache if expired or doesn't exist
  if (!configCache || Date.now() - configLastLoaded > CONFIG_CACHE_TTL) {
    const config = await getConfig();
    configCache = config.notifications?.pushover;
    configLastLoaded = Date.now();
  }

  if (!configCache?.enabled) {
    throw new Error("Pushover notifications are not enabled");
  }

  if (!configCache?.app_token || !configCache?.user_key) {
    throw new Error("Pushover configuration is missing or incomplete");
  }

  return configCache;
}

async function buildNotificationPayload(
  plateNumber,
  config,
  customMessage = null,
  imageData = null,
  overrides = {}
) {
  // Build message without requiring plate details
  let message = customMessage;

  if (!message) {
    message = `🚗 Plate ${plateNumber} Detected\n`;
    // message += `\n🕒 Time: ${new Date().toLocaleString()}`;
  }

  const basePayload = {
    token: config.app_token,
    user: config.user_key,
    title: overrides.title || (customMessage ? "ALPR Test Notification" : `${plateNumber} Detected`),
    priority: Number.isInteger(Number(overrides.priority))
      ? Number(overrides.priority)
      : Number.isInteger(Number(config.priority)) ? Number(config.priority) : 1,
    message: message,
  };
  if (basePayload.priority === 2) {
    basePayload.retry = Number(overrides.retry || 30);
    basePayload.expire = Number(overrides.expire || 3600);
  }

  // Add optional configuration if present
  if (config.sound) basePayload.sound = config.sound;
  if (config.device) basePayload.device = config.device;
  if (config.url) basePayload.url = config.url;

  // Add image if available
  if (imageData) {
    const base64Data = imageData.replace(/^data:image\/[a-z]+;base64,/, "");
    basePayload.attachment_base64 = base64Data;
    basePayload.attachment_type = "image/jpeg";
  }

  return basePayload;
}

export async function sendPushoverNotification(
  plateNumber,
  customMessage = null,
  imageData = null,
  overrides = {}
) {
  try {
    const config = await getPushoverConfig();

    if (!plateNumber) {
      throw new Error("Plate number is required");
    }

    const payload = await buildNotificationPayload(
      plateNumber,
      config,
      customMessage,
      imageData,
      overrides
    );

    const response = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Pushover API error: ${errorText}`);
    }

    const result = await response.json();
    return {
      success: true,
      data: result,
    };
  } catch (error) {
    console.error("Notification error:", error);
    return {
      success: false,
      error: error.message || "Failed to send notification",
    };
  }
}

// Utility to validate Pushover configuration
export async function validatePushoverConfig() {
  try {
    const config = await getPushoverConfig();

    const response = await fetch(
      "https://api.pushover.net/1/users/validate.json",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token: config.app_token,
          user: config.user_key,
        }),
      }
    );

    const result = await response.json();
    return {
      success: response.ok,
      data: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}
