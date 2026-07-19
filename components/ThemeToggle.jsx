// components/ThemeToggle.jsx
"use client"

import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { forwardRef } from "react"

import { Button } from "@/components/ui/button"

export const ThemeToggle = forwardRef(function ThemeToggle(
  { onClick, ...props },
  ref
) {
  const { theme, setTheme } = useTheme()

  const handleClick = (event) => {
    onClick?.(event)
    if (!event.defaultPrevented) {
      setTheme(theme === "light" ? "dark" : "light")
    }
  }

  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      {...props}
      onClick={handleClick}
    >
      <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  )
})
