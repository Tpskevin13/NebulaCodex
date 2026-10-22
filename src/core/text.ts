/**
 * Limpieza de texto para la terminal. Lo pegado o producido por comandos puede traer secuencias de control
 * (colores ANSI, marcadores de "pegado entre corchetes", retornos de carro) que desordenan la pantalla.
 */

// Ink le quita el ESC inicial a lo que recibe, por eso el marcador puede llegar sin él ("[200~").
const BRACKETED_PASTE = /\u001b?\[20[01]~/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// Parámetros CSI: incluye ':' para los colores 24 bits modernos (38:2::R:G:B).
const ANSI_CSI = /\u001b\[[0-9;:?]*[ -\/]*[@-~]/g;
// Caracteres de control salvo tabulación (9) y salto de línea (10).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function stripEscapes(text: string): string {
  return text.replace(BRACKETED_PASTE, "").replace(ANSI_OSC, "").replace(ANSI_CSI, "");
}

/** Texto escrito o pegado por el usuario, y texto mostrado en el historial: \r se toma como salto de línea. */
export function cleanText(text: string): string {
  return stripEscapes(text).replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(/\t/g, "  ");
}

/** Salida de un comando: \r reescribe la línea (barras de progreso), como haría una terminal. */
export function cleanOutput(text: string): string {
  return stripEscapes(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r").filter(Boolean);
      return segments.length ? segments[segments.length - 1] : "";
    })
    .join("\n")
    .replace(CONTROL, "");
}

/** Una sola línea sin saltos (rutas, búsquedas). No recorta espacios: se aplica mientras el usuario escribe. */
export function cleanLine(text: string): string {
  return cleanText(text).replace(/\n+/g, " ");
}

/** Valores sin espacios (claves de API, URLs, nombres de modelo): quita cualquier espacio o salto. */
export function cleanToken(text: string): string {
  return cleanText(text).replace(/\s+/g, "");
}
