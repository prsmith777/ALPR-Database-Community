export function scrollMainToTop() {
  if (typeof document === "undefined") return;

  const main = document.querySelector("main");
  if (main && typeof main.scrollTo === "function") {
    main.scrollTo({ top: 0, left: 0, behavior: "auto" });
    return;
  }

  if (typeof window !== "undefined") {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }
}

export function scrollMainToBottom() {
  if (typeof document === "undefined") return;

  const main = document.querySelector("main");
  if (main && typeof main.scrollTo === "function") {
    main.scrollTo({
      top: main.scrollHeight,
      left: 0,
      behavior: "smooth",
    });
    return;
  }

  if (typeof window !== "undefined") {
    window.scrollTo({
      top: document.documentElement?.scrollHeight || document.body?.scrollHeight || 0,
      left: 0,
      behavior: "smooth",
    });
  }
}
