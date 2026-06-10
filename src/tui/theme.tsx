import React from "react";
import { ThemeProvider, extendTheme, defaultTheme } from "@inkjs/ui";

const brandTheme = extendTheme(defaultTheme, {
  components: {
    Badge: {
      styles: {
        container: () => ({ }),
      },
    },
    ProgressBar: {
      styles: {
        filled: () => ({ color: "#3b7a57" }),
        remaining: () => ({ color: "#6b685b" }),
      },
    },
    StatusMessage: {
      styles: {
        icon: ({ variant }: { variant: string }) => ({
          color: variant === "success" ? "#3b7a57"
            : variant === "error" ? "#c0392b"
            : variant === "warning" ? "#c2891b"
            : "#4a6877",
        }),
      },
    },
  },
});

export function ThemeWrapper({ children }: { children: React.ReactNode }): React.ReactElement {
  return <ThemeProvider theme={brandTheme}>{children}</ThemeProvider>;
}
