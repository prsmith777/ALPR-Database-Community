import { initializeAuth } from "@/lib/auth";

let initialized = false;
let initializationPromise = null;

export async function ensureInitialized() {
  if (initialized) return;

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  // Start initialization
  initializationPromise = (async () => {
    try {
      await initializeAuth();
      initialized = true;
    } catch (error) {
      console.error("Authentication system initialization failed");
      throw error;
    } finally {
      initializationPromise = null;
    }
  })();

  await initializationPromise;
}
