// The script an official Rspress page inlines, so a dark page never flashes white. External so the page needs no inline script.
{
  const saved = localStorage.getItem("rspress-theme-appearance");
  const preferDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved === "light" || saved === "dark" || saved === "auto" ? saved : "auto";
  const isDark = theme === "auto" ? preferDark : theme === "dark";
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.classList.toggle("rp-dark", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
}
