# Auditoría técnica de NebulaCodex

Fecha: 2026-10-20
Alcance: revisión completa de `src/`, scripts, pruebas y lanzadores; corrección de defectos; verificación con pruebas unitarias, integración y llamadas reales a proveedores.

## Resumen ejecutivo

La base funcionaba, pero tenía problemas de robustez que aparecían justo en los caminos más costosos: streaming, cancelación, herramientas, red y proveedores. Los más graves eran:

1. **OpenRouter devolvía HTTP 402** porque el stream no enviaba `max_tokens` y el gateway reservaba la salida máxima del modelo (hasta 131k tokens). Se agregó un tope configurable y el campo correcto según el proveedor.
2. **Una respuesta cortada podía borrar todo el turno del historial**, dejando al modelo sin memoria de los archivos que ya había modificado y facilitando ediciones duplicadas.
3. **No había reintentos, timeouts ni topes de respuesta** en el camino HTTP/SSE; una conexión colgada o un proveedor lento bloqueaba la aplicación.
4. **El bucle de herramientas no detectaba repeticiones**, por lo que un modelo podía ejecutar la misma escritura una y otra vez.
5. **`fetch_url` podía alcanzar `localhost`, rangos privados y metadatos**, incluso mediante una redirección. Ahora resuelve DNS antes de conectar, valida cada salto y bloquea loopback, redes privadas, link-local, multicast y metadatos.
6. **El Markdown se mostraba literal**: `**negrita**` aparecía con asteriscos y sin estilo. Ahora las respuestas del asistente se convierten en spans de Ink con negrita, cursiva, código, listas, encabezados, enlaces y tablas, sin ejecutar HTML.
7. **La exportación y algunas herramientas tenían carreras o consumos de memoria innecesarios**: creación exclusiva de archivos, límite de 4 MiB y rechazo de binarios al editar, conteo lineal de coincidencias y detección de symlinks colgantes.

Después de los cambios, `npm run build` compila sin errores y `npm test` ejecuta **82 pruebas: 80 pasan, 0 fallan y 2 se omiten por ser específicas de POSIX**. Las llamadas reales de texto y tool calling funcionan con Groq, NVIDIA y OpenRouter (GLM 5.3 y DeepSeek V4.1 Flash).

## Hallazgos y resoluciones

| Severidad | Área | Hallazgo | Resolución | Riesgo residual |
| --- | --- | --- | --- | --- |
| Crítica | Proveedores | Sin `max_tokens`, OpenRouter reservaba el máximo del modelo y devolvía 402 | `outputTokenLimit()` + `Config.maxOutputTokens` (256–65.536); OpenAI de razonamiento usa `max_completion_tokens` | El tope global puede truncar tareas que necesiten más de 8k tokens; se puede subir en config |
| Alta | Streaming | Sin timeout de headers ni de inactividad; SSE podía quedar colgado | `fetchWithRetry` con timeout de headers; `sseData` con timeout de inactividad de 120 s y tope de buffer | Un proveedor puede tardar legítimamente más de 120 s en una generación larga |
| Alta | Streaming | BOM, índices ausentes, nombres repetidos, JSON inválido y flujos sin `[DONE]`/`message_stop` | Parser SSE reescrito y validación de cierre; llamadas inválidas se marcan `__invalid_tool_call__` | Algunos gateways exóticos pueden usar formatos no cubiertos |
| Alta | Historial | Un abort/error descartaba todo el turno y dejaba `tool_use` huérfanos | `recoverHistory()` conserva turnos completos y cierra herramientas pendientes; `normalizeConversation()` repara chats cargados | El historial reparado puede contener un aviso de interrupción, no el resultado real |
| Alta | Agente | Repetición infinita del mismo lote de herramientas | `createLoopGuard()` + `registerToolBatch()` con firma estable | Un bucle con argumentos ligeramente distintos no se detecta |
| Alta | Seguridad | `fetch_url` podía alcanzar endpoints locales o de metadatos, directo o por redirección | Resolución DNS previa, bloqueo de loopback/privadas/link-local/multicast/metadatos, `redirect: "manual"` y validación de cada salto (máx. 5) | Persiste una ventana TOCTOU de DNS rebinding entre la resolución y la conexión |
| Alta | UI | `**bold**`, `*italic*` y `***both***` se mostraban literales | Parser GFM (`marked`) a spans con estilos de Ink; sólo las respuestas del asistente se renderizan como Markdown | Formatos GFM exóticos pueden degradar a texto; no hay ejecución de HTML |
| Media | Búsqueda | Escaneo sin límites de archivos, bytes, resultados o tamaño de línea | Límites de 50k entradas, 128 MiB, 200 resultados, 2 MiB por archivo y 2.000 caracteres por línea | Una regex catastrófica todavía puede consumir CPU dentro de esos límites |
| Media | Configuración | Un JSON inválido se sobrescribía al guardar y se perdían las claves; una config sin `active` borraba proveedores | Copia `.invalid` única antes de continuar; sanitización campo por campo; `active` faltante conserva proveedores; claves `__proto__`/`constructor`/`prototype` se ignoran; escritura atómica con permisos 0600 | El archivo contiene claves en texto plano; depende de los permisos del usuario |
| Media | Chats | `listChats()` parseaba todos los chats completos en cada apertura | Caché por `mtime`/tamaño, invalidada al guardar | La caché vive en memoria del proceso |
| Media | Exportación | Nombres peligrosos, fences sin adaptar, encabezados multilínea y carrera entre comprobar y escribir | Nombres seguros/únicos, fences más largos que el contenido, títulos de una línea y creación exclusiva con `flag: "wx"` | No se probó en todos los sistemas de archivos |
| Media | Edición | `edit_file` podía cargar archivos enormes, aceptar binarios y crear arrays gigantes al contar coincidencias | Límite de 4 MiB, rechazo de NUL, conteo con `indexOf` y reemplazo literal con callback | Editar archivos cercanos a 4 MiB sigue consumiendo memoria proporcional |
| Media | Enrutamiento | "render" clasificaba una arquitectura de renderizado como imagen | Se quitó `render` de la regla de imagen y se agregó una prueba de regresión | El clasificador determinista puede fallar en prompts ambiguos |
| Baja | Terminal | ANSI con parámetros de dos puntos (`38:2::…`) dejaba residuos; filas anchas y emojis se partían mal | Limpieza CSI corregida; wrapping por grafemas y `string-width` para caracteres anchos | Algunas secuencias privadas de terminales exóticas pueden no cubrirse |
| Baja | Movimiento/undo | Un symlink colgante en el destino pasaba desapercibido con `existsSync` | `lstat` detecta cualquier entrada, incluido un enlace roto | No hay sandbox: la aprobación sigue siendo la defensa principal |
| Baja | Títulos | La generación del título podía quedar colgada o pisar el chat activo | Timeout de 15 s, cancelación por chat y truncado a 30 caracteres | Un título generado por un modelo lento puede caer al valor de respaldo |
| Baja | UI | Filas largas se recortaban; el splash no se podía saltear | Render por filas memoizado, scroll por filas y splash salteable | La interfaz no tiene pruebas E2E de terminal real |

## Cambios por módulo

### Núcleo

- `src/core/types.ts`: `TaskKind`, `ModelRef`, `RoutingConfig`, `Config.routing`, `Config.maxOutputTokens`, `Config.lastDirectory`.
- `src/core/providers/http.ts`: reintentos con backoff y jitter, respeto de `Retry-After`, timeout de headers, `HttpError` con detalle, lectura con tope de bytes.
- `src/core/providers/stream.ts`: tope de salida, reintentos, SSE con BOM/timeout, merge de turnos de Anthropic, protección contra nombres de herramienta duplicados.
- `src/core/providers/models.ts`: reintentos, timeout y filtrado de modelos que no son de chat.
- `src/core/providers/config.ts`: sanitización de routing, `lastDirectory`, `maxOutputTokens` y proveedores; `active` faltante conserva las claves; protección contra claves de prototipo; copias de archivos inválidos.
- `src/core/agent.ts`: firmas estables de herramientas, guardia de bucles, recuperación y normalización del historial.
- `src/core/routing.ts`: clasificador determinista, parseo/resolución de referencias y selección tarea → principal → activo.
- `src/core/chats.ts`: carga normalizada, caché por `mtime`/tamaño, escritura atómica.
- `src/core/tools.ts`: límites de búsqueda y lectura, bloqueo SSRF con DNS y redirecciones, tope de descarga, salida de comandos por bytes, edición limitada, detección de symlinks y advertencias de undo.
- `src/core/export.ts`: nombres seguros, fences, encabezados y creación exclusiva sin pisar archivos.
- `src/core/text.ts`: limpieza de ANSI/controles, incluidos parámetros CSI con `:`.

### Aplicación y UI

- `src/app/App.tsx`: restaura la última carpeta, splash salteable, títulos cancelables, enrutamiento por tarea, `/route`, guardia de bucles, recuperación de historial, filas memoizadas, spans con estilos y repintado del stream como máximo cada 50 ms.
- `src/ui/markdown.ts`: parser GFM a spans (`marked` 15.0.12) con negrita, cursiva, tachado, código, enlaces, encabezados, listas, tareas, citas, tablas y reglas; el HTML se muestra como texto, nunca se ejecuta.
- `src/ui/rows.ts`: modelo de fila con spans obligatorios, Markdown sólo para el asistente, wrapping por grafemas, anchos de terminal y truncado seguro.
- `src/ui/theme.ts`: system prompt endurecido contra instrucciones del contenido descargado y guía para usar GFM estándar sin HTML.
- `src/ui/ProvidersScreen.tsx`: conserva routing y `lastDirectory` al guardar proveedores.
- `iniciar.ps1` / `iniciar.sh`: `NEBULACODEX_WORKDIR`, arranque desde el home si no hay carpeta, instalación/compilación incremental.

## Seguridad

Defensas presentes:

- Las herramientas que escriben, mueven, borran, descargan o ejecutan comandos piden aprobación explícita (`NEEDS_APPROVAL`).
- `run_command` tiene timeout de 120 s, tope de salida de 10 MiB y terminación del árbol de procesos.
- `read_file` y `edit_file` limitan a 4 MiB; `search_text` a 2 MiB por archivo y 128 MiB totales.
- `fetch_url` sólo acepta HTTP/HTTPS, valida DNS antes de conectar, bloquea loopback, rangos privados, link-local, multicast y metadatos, rechaza binarios y limita a 5 MiB/20 s y 5 redirecciones.
- Cada redirección se valida como una URL nueva antes de seguirla; no se reutiliza la aprobación para un destino distinto.
- La configuración y los chats se escriben con permisos restrictivos en POSIX y de forma atómica; la exportación usa creación exclusiva.
- El HTML descargado o escrito por el modelo se trata como texto: no se ejecuta y el Markdown no permite inyección de terminal.

Riesgos que **no** se eliminan:

- No hay sandbox de sistema operativo: el agente puede leer/escribir cualquier ruta a la que el usuario tenga acceso, y ejecutar comandos con los mismos privilegios. La aprobación es la barrera real.
- **DNS rebinding:** la comprobación resuelve el host antes de conectar, pero el resolver podría devolver otra IP en la conexión real. Cerrar esa ventana requiere un `lookup` propio en el socket/agente HTTP o un proxy con allowlist.
- El contenido descargado puede contener prompt injection. El system prompt lo advierte, pero no existe una separación técnica entre datos e instrucciones.
- Las claves de API están en texto plano en `~/.nebulacodex/config.json`.
- Las regex de búsqueda son aportadas por el usuario/modelo; el recorte de línea reduce pero no elimina el riesgo de retroceso excesivo.

## Rendimiento

- Markdown se parsea sólo en respuestas del asistente y el repintado del stream se limita a 50 ms, en lugar de reparsear cada delta SSE.
- Caché de chats por `mtime`/tamaño: evita parsear todos los JSON al abrir el buscador.
- Búsqueda literal: una sola conversión a minúsculas por archivo, no por línea.
- Filas de la UI memoizadas; el scroll no reconstruye todo el historial.
- Instalación/compilación incremental en los lanzadores.
- Topes de salida y de descarga para evitar reservas y buffers desmedidos.
- Enrutamiento determinista: no gasta una llamada extra de modelo para clasificar.

## Anomalías restantes

1. **Modelos premium sin evaluar**: Claude Opus 5.5, GPT-6 Sol y Gemini 4 Argon no se pudieron medir de forma completa por crédito/cuota. No se recomiendan como principal sin una prueba pagada.
2. **Presets potencialmente desactualizados**: el preset de Anthropic sigue usando `claude-sonnet-4-5`; conviene revisar los IDs al cambiar de plan.
3. **Sin 3D real**: el proyecto no genera mallas, UVs, texturas ni animaciones. `three_d` sólo enruta especificaciones y código Three.js. Ver `docs/MODELS.md`.
4. **Sin visión de imágenes**: el tipo `vision` existe, pero la aplicación no adjunta imágenes al mensaje; no se configuró esa ruta para no simular una capacidad inexistente.
5. **Cobertura E2E limitada**: no hay pruebas automatizadas de la TUI completa, del `.exe` ni de los lanzadores en macOS/Linux.
6. **Dos pruebas omitidas en Windows**: procesos en segundo plano y limpieza de ANSI dependen de POSIX.
7. **DNS rebinding residual**: documentado arriba; no se implementó un agente HTTP con IP fijada.
8. **Un solo benchmark por tarea**: los puntajes son indicativos, no estadísticamente significativos. DeepSeek mostró gran varianza (un refactor quedó sin salida con 5k tokens y otro pasó con 100%).
9. **Sin pruebas de carga/soak**: no se midió memoria en sesiones de muchas horas ni archivos gigantes.
10. **Sin repositorio git**: los cambios se respaldaron en `C:\Users\<usuario>\AppData\Local\Temp\opencode\nebulacodex-backup-20261020-183858`.

## Verificación

```powershell
npm run build
npm test
npm run check:live -- groq/openai/gpt-oss-120b nvidia/nvidia/nemotron-3-ultra-550b-a55b openrouter/z-ai/glm-5.3 openrouter/deepseek/deepseek-v4.1-flash
```

Resultados detallados en `docs/TEST-REPORT.md`; selección de modelos en `docs/MODELS.md`.
