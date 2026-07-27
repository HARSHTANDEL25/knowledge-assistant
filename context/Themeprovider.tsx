
"use client";
import { createContext, useContext, useEffect, useState } from "react";

const ThemeContext = createContext({ theme: "light", toggletheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [theme, setTheme] = useState("light");
  useEffect(() => {
        const stored = localStorage.getItem("ka_theme");
        if (stored === "dark" || stored === "light")
            setTheme(stored);
    }, [])

    useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
        localStorage.setItem("ka_theme", theme);
    }, [theme])

    function toggletheme() {
        setTheme((t) => (t === "light" ? "dark" : "light"));
    }

    return (
        <ThemeContext.Provider value={{ theme, toggletheme }}>
            {children}
        </ThemeContext.Provider>
    )
}
export function useTheme() {
    return useContext(ThemeContext)
}