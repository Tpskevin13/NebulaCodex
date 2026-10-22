import fs from "node:fs";

/**
 * En Windows, renombrar sobre un archivo existente puede fallar un instante (EPERM/EBUSY/EACCES) si el
 * antivirus o el indexador lo tienen abierto; sin reintentos el guardado se perdía en silencio.
 */
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1));
    }
  }
}
