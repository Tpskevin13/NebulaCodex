# Informe de pruebas

Fecha: 2026-10-20
Entorno: Windows, Node.js v24.15.0, npm 11.12.1, TypeScript estricto (`strict`, `noUnusedLocals`, `noUnusedParameters`).
Proyecto: `C:\Users\<usuario>\Project\nebulacodex`

## Resumen

| Verificación | Resultado |
| --- | --- |
| Compilación (`npm run build`) | ✅ Sin errores |
| Pruebas automatizadas (`npm test`) | ✅ 82 pruebas · 80 pasan · 0 fallan · 2 omitidas |
| Llamadas reales de texto | ✅ Groq, NVIDIA, OpenRouter (GLM y DeepSeek) |
| Tool calling real | ✅ Los cuatro modelos devolvieron `read_file({"path":"src/core/routing.ts"})` |
| Render Markdown en terminal | ✅ Negrita, cursiva, código, listas, tablas y enlaces sin marcadores visibles |
| Benchmark de modelos | ✅ 6 modelos × 8 tareas, con reintentos documentados |
| Configuración y enrutamiento | ✅ Carga y decisiones verificadas manualmente |
| TUI / ejecutable / lanzadores | ⚠️ Sin prueba E2E automatizada |

## Pruebas automatizadas

```text
tests 82
pass  80
fail   0
skipped 2
duration ~2,7 s
```

| Archivo | Pruebas | Cobertura |
| --- | ---: | --- |
| `test/smoke.test.ts` | 20 | Herramientas de archivo, búsqueda, edición, undo, `fetch_url`, comandos, configuración, historial, SSE, renderer y seguridad de red |
| `test/rows.test.ts` | 5 | Layout de filas, mensajes largos, resultados de herramientas, secuencias de control, scroll |
| `test/markdown.test.ts` | 7 | Énfasis, escapes, Markdown malformado, fences, listas, citas, enlaces, wrapping y emojis |
| `test/paste.test.ts` | 10 | Pegado multilínea, marcadores, borrado y expansión |
| `test/screen.test.ts` | 3 | Alt screen, restauración y secuencias de terminal |
| `test/agent.test.ts` | 6 | Firmas estables, guardia de bucles, recuperación y normalización del historial |
| `test/routing.test.ts` | 9 | Clasificación, parseo de referencias, cadena de decisión, sanitización de config y placeholders |
| `test/providers.test.ts` | 13 | Reintentos, timeouts, `Retry-After`, SSE, tool calls, Anthropic, topes de salida y listado de modelos |
| `test/export.test.ts` | 2 | Nombres seguros, fences/encabezados y creación sin sobrescritura |
| `test/tools-safety.test.ts` | 7 | Metadatos, rangos privados, redirecciones, binarios, tamaño, entradas gigantes y undo |

### Pruebas nuevas relevantes

- **Markdown visible:** verifica que `**negrita**`, `*cursiva*` y `***ambas***` producen spans con estilo y no dejan los marcadores en el texto; los asteriscos literales y los bloques de código se conservan.
- **Wrapping con estilos:** comprueba que el corte de línea no rompe grafemas (emojis/acentos combinados), respeta caracteres anchos y conserva el estilo de cada fragmento.
- **Topes de salida:** verifica que OpenAI-compatible envía `max_tokens`, que OpenAI directo usa `max_completion_tokens` en modelos de razonamiento, que el valor se recorta a 256–65.536 y que Anthropic también respeta el tope.
- **Recuperación de historial:** un corte conserva turnos completos, cierra `tool_use` pendientes, elimina resultados huérfanos y sanea IDs duplicados.
- **Guardia de bucles:** detecta el mismo lote de herramientas con firmas estables aunque cambie el orden de las claves.
- **Seguridad de `fetch_url`:** bloquea metadatos, loopback, IPv6, rangos privados y redirecciones hacia loopback antes de la request; también rechaza binarios y corta respuestas chunked que superan 5 MiB.
- **Edición y undo:** rechaza archivos binarios y mayores de 4 MiB, cuenta coincidencias sin materializar arrays gigantes y no pisa destinos que son symlinks colgantes.
- **Configuración:** conserva routing/`lastDirectory`, descarta tareas inválidas, mantiene proveedores si falta `active`, ignora claves de prototipo y crea copias de archivos corruptos.
- **ANSI:** limpia secuencias CSI con parámetros de dos puntos (`\u001b[38:2::255:0:0m`) sin comerse el texto siguiente.
- **Exportación:** crea el archivo de forma exclusiva y no sobrescribe uno existente.
- **Clasificador:** "motor de render" ya no se confunde con una imagen.

### Pruebas omitidas

Se omiten en Windows porque dependen de POSIX:

1. `runCommand does not wait for background processes that outlive the shell`
2. `runCommand strips ANSI colours from command output`

## Llamadas reales a proveedores

Ejecutadas con `npm run check:live`, usando el mismo `streamChat` de la aplicación y el tope configurado de 8.192 tokens:

| Proveedor / modelo | Texto | Tool call | Resultado |
| --- | ---: | ---: | --- |
| Groq · `openai/gpt-oss-120b` | 631 ms | 525 ms | `read_file({"path":"src/core/routing.ts"})` |
| NVIDIA · `nvidia/nemotron-3-ultra-550b-a55b` | 1.214 ms | 1.210 ms | `read_file({"path":"src/core/routing.ts"})` |
| OpenRouter · `z-ai/glm-5.3` | 1.349 ms | 2.677 ms | `read_file({"path":"src/core/routing.ts"})` |
| OpenRouter · `deepseek/deepseek-v4.1-flash` | 1.152 ms | 9.331 ms | `read_file({"path":"src/core/routing.ts"})` |

DeepSeek agregó una frase antes del tool call (`Voy a leer el archivo solicitado.`) y su latencia de herramienta varió más que la de los otros modelos. NVIDIA también mostró variación entre corridas. Antes de agregar `max_tokens`, OpenRouter devolvía **HTTP 402** (`requires more credits, or fewer max_tokens`). Después del cambio, las cuatro llamadas anteriores completaron sin error, incluso con el tope real de 8.192 tokens.

## Benchmark de modelos

`npm run eval` ejecutó 8 tareas por modelo. Resultados principales:

| Modelo | Puntaje ponderado | Mediana | Tareas perfectas |
| --- | ---: | ---: | ---: |
| GLM 5.3 | 100,0% | 1.735 ms | 8/8 |
| GPT-OSS 120B (Groq) | 100,0% | 1.877 ms | 8/8 |
| Nemotron 3 Ultra | 100,0% | 6.267 ms | 8/8 |
| DeepSeek V4.1 Flash | 100,0% | 5.673 ms | 8/8 |
| Gemini 3.8 Flash (directo) | 100,0% | 37.509 ms | 8/8 |
| GPT-6 Luna | 98,3% | 4.453 ms | 7/8 (`chat`) |

### Correcciones aplicadas durante la evaluación

1. **Scoring de Three.js:** la heurística no aceptaba imports por CDN (`three.module.js`), geometrías `BufferGeometry`, `ResizeObserver` ni métodos de clase `dispose()`. Se corrigió y se re-puntuaron las salidas guardadas sin nuevas llamadas. Los seis modelos pasaron de 83–100% a 100% en esa tarea.
2. **DeepSeek refactor:** la primera corrida quedó sin salida por agotar 5k tokens en razonamiento. Se amplió el presupuesto de reintento a 12k y se reejecutó: 5/5 casos, 100%, 2,2 s. Esto evidencia varianza, no una mejora del modelo.
3. **Gemini 3.8 Flash:** cuatro tareas fallaron por 429/503 de la capa gratuita. Se reejecutaron con `--delay=20000` y pasaron al 100%; los tiempos de 35–61 s reflejan la cuota y los reintentos, no la velocidad del modelo.
4. **Clasificador:** "Diseñá la arquitectura de un motor de render" caía en `image` por la palabra "render"; ahora cae en `reasoning`.

Los datos crudos, incluidos textos y uso de tokens, están en `docs/model-eval.json`. Las copias previas a cada corrección (`model-eval.pre-*.json`) no se incluyen en el repositorio.

## Verificación de configuración

Se cargó la configuración real y se ejecutó el clasificador:

| Prompt | Tarea | Origen | Modelo |
| --- | --- | --- | --- |
| "arreglá este bug en el parser" | `debug` | principal | `groq/openai/gpt-oss-120b` |
| "diseñá la arquitectura de un motor de render" | `reasoning` | tarea | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` |
| "hacé un cristal low-poly para Three.js" | `three_d` | tarea | `openrouter/z-ai/glm-5.3` |
| "hola, contame algo corto" | `chat` | principal | `groq/openai/gpt-oss-120b` |

También se verificó que `maxOutputTokens: 8192` se conserva al cargar y que la copia previa de la configuración existe en `C:\Users\<usuario>\AppData\Local\Temp\opencode\nebulacodex-config-before-routing.json`.

## Anomalías restantes

1. **Sin E2E de la TUI**: las pruebas de `screen`, `rows` y `markdown` cubren piezas, no una sesión real de terminal con teclas, resize y aprobaciones.
2. **Sin prueba del `.exe`**: no se ejecutó `release/NebulaCodex.exe` ni `build-exe.ps1`; sólo se validó el código TypeScript.
3. **Sin prueba de lanzadores en macOS/Linux**: `iniciar.sh` no se ejecutó en este entorno Windows.
4. **Dos omisiones POSIX** descritas arriba.
5. **DNS rebinding residual**: la validación SSRF resuelve el host antes de conectar, pero no fija la IP en el socket; un resolver malicioso podría cambiar la respuesta entre ambos pasos. Se requiere un agente HTTP con `lookup` propio para cerrar esa ventana.
6. **Premium sin evaluar**: Claude Opus 5.5, GPT-6 Sol y Gemini 4 Argon no se pudieron probar por crédito/cuota. Los puntajes de los modelos gratuitos no se extrapolan a ellos.
7. **Gemini free tier no es Production-ready**: la cuota gratuita produjo 429/503; los tiempos altos son reales para ese plan.
8. **DeepSeek presenta varianza** en tareas de razonamiento: puede necesitar 12k tokens y 40–50 s, o resolver en 2 s.
9. **Sin 3D ni imágenes**: no hay pipeline de mallas, texturas ni adjuntos de imagen; no se probó nada de eso porque no existe.
10. **Clasificador determinista**: prompts ambiguos pueden caer en la tarea equivocada; se corrigió el caso de "render", pero el enfoque por regex tiene límites. `/route` permite override.
11. **Sin soak/load test**: no se midió memoria ni estabilidad en sesiones de varias horas.
12. **Presets posiblemente desactualizados**: el preset de Anthropic sigue apuntando a `claude-sonnet-4-5`; verificar IDs antes de usar planes nuevos.
13. **Sin git**: no hay historial de commits; los respaldos son copias en `%TEMP%`.

## Conclusión

El camino crítico quedó cubierto: compilación, 82 pruebas, streaming real, tool calling real, render Markdown, reintentos, cancelación, historial, seguridad de red y de herramientas, y enrutamiento. Las dos áreas que **no** se pueden declarar terminadas son la generación 3D/imágenes (no implementada) y la validación E2E del ejecutable y la TUI en un entorno real. Tampoco se elimina la ventana de DNS rebinding sin un transporte HTTP con IP fijada.
