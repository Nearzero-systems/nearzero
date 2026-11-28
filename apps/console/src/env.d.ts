/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Messages to show as toasts on this page, set by the request before a redirect. */
    flash: { message: string; tone: "info" | "success" | "error" }[];
    /** This request's data access (lib/data), made once and shared by the page and the shell. */
    consoleData?: import("./lib/data/types.ts").ConsoleData;
  }
}
