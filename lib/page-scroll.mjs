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
