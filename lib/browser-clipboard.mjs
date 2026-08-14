function legacyCopy(text, documentObject) {
  if (
    !documentObject?.body ||
    typeof documentObject.createElement !== "function" ||
    typeof documentObject.execCommand !== "function"
  ) {
    return false;
  }

  const previousFocus = documentObject.activeElement;
  const textArea = documentObject.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  Object.assign(textArea.style, {
    position: "fixed",
    left: "-9999px",
    top: "0",
    opacity: "0",
    pointerEvents: "none",
  });
  documentObject.body.appendChild(textArea);

  try {
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange?.(0, text.length);
    return documentObject.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    if (typeof textArea.remove === "function") textArea.remove();
    else documentObject.body.removeChild?.(textArea);
    previousFocus?.focus?.();
  }
}

export async function copyTextToClipboard(
  value,
  {
    clipboard = globalThis.navigator?.clipboard,
    documentObject = globalThis.document,
  } = {},
) {
  const text = String(value ?? "");
  if (!text) return false;

  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Direct-LAN HTTP pages commonly reject the secure-context API. The
      // synchronous fallback below remains inside the original user gesture.
    }
  }

  return legacyCopy(text, documentObject);
}

export const browserClipboardInternals = Object.freeze({ legacyCopy });
