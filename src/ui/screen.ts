/**
 * Pantalla alternativa de la terminal (la que usan vim o htop).
 * - No deja historial: al maximizar, minimizar o redimensionar la ventana no quedan restos arriba.
 * - La terminal no reordena su contenido al cambiar de tamaño: el programa simplemente se repinta.
 * - Al salir se vuelve a la pantalla anterior tal como estaba.
 */
// 1049: pantalla alternativa. 1007: la rueda del mouse envía flechas (permite recorrer el historial con ella).
export const ENTER_ALT_SCREEN = "\u001B[?1049h\u001B[2J\u001B[H\u001B[?1007h";
export const LEAVE_ALT_SCREEN = "\u001B[?1007l\u001B[?25h\u001B[?1049l";

export function createAltScreen(write: (text: string) => void, writeSync: (text: string) => void) {
  let active = false;
  return {
    get active() {
      return active;
    },
    enter() {
      if (active) return;
      active = true;
      write(ENTER_ALT_SCREEN);
    },
    /** Es seguro llamarla varias veces y desde un manejador de salida (escribe de forma síncrona). */
    leave() {
      if (!active) return;
      active = false;
      try {
        writeSync(LEAVE_ALT_SCREEN);
      } catch {
        // la terminal ya se cerró: no hay nada que restaurar
      }
    },
  };
}
