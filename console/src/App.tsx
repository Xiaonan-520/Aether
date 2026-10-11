import { ThemeProvider, useTheme } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { ConsoleApp } from "@/console-app"

export function App() {
  return (
    <ThemeProvider storageKey="gw-console-theme" defaultTheme="dark">
      <ThemeShell />
    </ThemeProvider>
  )
}

function ThemeShell() {
  const { theme, setTheme } = useTheme()
  return (
    <>
      <ConsoleApp
        theme={theme === "light" ? "light" : "dark"}
        onToggleTheme={() => setTheme(theme === "light" ? "dark" : "light")}
      />
      <Toaster position="bottom-right" />
    </>
  )
}

export default App
