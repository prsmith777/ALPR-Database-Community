import { PROJECT_DESCRIPTION, PROJECT_NAME } from "@/lib/project-info";

export default function manifest() {
  return {
    theme_color: "#000000",
    background_color: "#09090b",
    icons: {
      icon: [
        {
          url: "/1024.png",
          sizes: "1024x1024",
          type: "image/png",
          purpose: "any",
        },
      ],
      apple: [{ url: "/1024.png" }],
    },
    orientation: "any",
    display: "standalone",
    dir: "auto",
    lang: "en-US",
    name: PROJECT_NAME,
    short_name: "ALPR Community",
    start_url: "/",
    scope: "/",
    description: PROJECT_DESCRIPTION,
  };
}
