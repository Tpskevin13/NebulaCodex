# Selección de modelos y enrutamiento

Fecha de evaluación: 2026-10-20
Datos crudos: `docs/model-eval.json` (sin claves de API)

## Metodología

Se ejecutaron llamadas reales con `npm run eval` contra 8 tareas reproducibles:

| Tarea | Peso | Qué mide |
| --- | --- | --- |
| `code` | 0,15 | `mergeIntervals` ejecutada en un sandbox `vm` con 9 casos y validaciones |
| `debug` | 0,20 | Diagnóstico de `forEach(async)` y corrección con orden y propagación de errores |
| `refactor` | 0,10 | Refactor de `activeUsers` con 5 casos, sin mutación y con comparación estricta |
| `docs` | 0,05 | JSDoc completo, ejemplo, jitter y límite máximo |
| `structured` | 0,10 | Especificación 3D en JSON con presupuesto, materiales y optimización |
| `threejs` | 0,10 | Módulo Three.js con escena, luces, fog, resize y `dispose()` |
| `chat` | 0,10 | Explicación breve y correcta de `useMemo` vs. `useCallback` |
| `tool` | 0,20 | Tool calling real para leer `src/core/routing.ts` |

El puntaje principal es el promedio ponderado. Las respuestas de código se ejecutan; no se puntúan por apariencia. Las llamadas usan el camino real de la aplicación (`streamChat`), no un wrapper distinto.

**Limitaciones:** una sola corrida por tarea, prompts sintéticos y un techo de 100% que cinco modelos alcanzaron. Los empates se resolvieron por latencia, contexto, costo y riesgo operativo, no por una diferencia estadística demostrada.

El render Markdown de las respuestas y el endurecimiento de `fetch_url`/exportación no cambian el camino de selección: el benchmark y las llamadas en vivo usan el mismo `streamChat` y el mismo enrutamiento.

## Resultados

| Modelo | Puntaje | Mediana | Contexto | Precio entrada/salida por 1M | Costo del benchmark | Rol |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| **GLM 5.3** (OpenRouter) | 100,0% | 1.735 ms | 1.048.576 | $0,08 / $1,40 | $0,0061 | 3D, contexto largo, respaldo de principal |
| **GPT-OSS 120B** (Groq) | 100,0% | 1.877 ms | 131.072 | $0 / $0 (plan actual) | $0,0000 | **Principal** |
| **Nemotron 3 Ultra** (NVIDIA NIM) | 100,0% | 6.267 ms | 262.144 | $0,60 / $2,40 | $0,0132 | Razonamiento pesado |
| **DeepSeek V4.1 Flash** (OpenRouter) | 100,0% | 5.673 ms | 1.048.576 | $0,03 / $0,12 | $0,0012 | Lotes económicos, borradores |
| **Gemini 3.8 Flash** (Google directo) | 100,0% | 37.509 ms | 1.048.576 | $0 / $0 (capa gratuita) | $0,0000 | Alternativa multimodal; cuota gratuita lenta |
| **GPT-6 Luna** (OpenRouter) | 98,3% | 4.453 ms | 1.050.000 | $0,10 / $0,50 | $0,0031 | Contexto largo económico |

Los cinco primeros empataron en las 8 tareas. GPT-6 Luna sólo perdió 0,167 en `chat` ("falta props/effects").

### Modelos premium no evaluados

| Modelo | Contexto | Precio | Estado |
| --- | ---: | ---: | --- |
| Claude Opus 5.5 | 1.000.000 | $4 / $20 | Sin crédito suficiente en OpenRouter; no se recomienda sin prueba pagada |
| GPT-6 Sol | 1.050.000 | $2 / $10 | Igual que el anterior |
| Gemini 4 Argon | 1.048.576 | $2 / $10 | Igual que el anterior |
| Qwen3.5 4B local | — | $0 | Ollama local tardó más de 180 s; no apto para uso interactivo en este equipo |

## Decisión: GPT-OSS 120B (Groq) como principal

Empató el primer puesto en calidad (100%), tiene la segunda mejor mediana (1,9 s), tool calling perfecto y no depende de crédito de OpenRouter. Para un agente que ejecuta muchas llamadas cortas, la latencia y la disponibilidad valen más que un contexto de 1M que casi nunca se usa.

**Cuándo cambiar:**

- **GLM 5.3** es el mejor candidato a principal alternativo: 1M de contexto, 1,7 s y costo bajísimo. Su debilidad es operativa: depende de OpenRouter y de que haya crédito. Si se paga OpenRouter de forma estable, GLM puede reemplazar a Groq con `/route principal openrouter/z-ai/glm-5.3`.
- **Nemotron 3 Ultra** es para razonamiento profundo, no para el bucle interactivo: 6,3 s y mayor costo.
- **DeepSeek V4.1 Flash** es el más barato por token, pero su razonamiento puede consumir el presupuesto y dejar la respuesta vacía; necesita topes de 8k–12k y tolerancia a latencias de 40–50 s. Sirve para lotes, no para el principal.
- **Gemini 3.8 Flash** tiene calidad y contexto, pero la capa gratuita impone 429/503 y la mediana real fue 37,5 s. Con facturación paga sería una opción multimodal seria.
- **GPT-6 Luna** es un buen segundo económico para contexto largo, aunque no superó a GLM en precio ni en puntaje.

## Enrutamiento configurado

La clasificación es determinista y no gasta una llamada extra. Cadena de decisión: **modelo de la tarea → principal → proveedor activo**.

| Tarea | Modelo | Justificación |
| --- | --- | --- |
| `principal`, `code`, `refactor`, `debug`, `docs`, `chat`, `fast` | `groq/openai/gpt-oss-120b` | Mejor equilibrio calidad/latencia/costo; sin dependencia de crédito |
| `reasoning` | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | 262k de contexto y el mejor perfil para análisis/arquitectura |
| `three_d` | `openrouter/z-ai/glm-5.3` | 100% en especificación 3D y Three.js, 1M de contexto, 1,7 s |
| `vision` | sin asignar | La app no adjunta imágenes; asignarlo sería simular una capacidad inexistente |
| `image` | sin asignar | No hay generación de imágenes integrada |

Configuración activa en `~/.nebulacodex/config.json`:

```json
{
  "active": "groq",
  "effort": "max",
  "maxOutputTokens": 8192,
  "routing": {
    "enabled": true,
    "principal": { "provider": "groq", "model": "openai/gpt-oss-120b" },
    "tasks": {
      "reasoning": { "provider": "nvidia", "model": "nvidia/nemotron-3-ultra-550b-a55b" },
      "three_d": { "provider": "openrouter", "model": "z-ai/glm-5.3" }
    }
  }
}
```

Comandos:

```text
/route status
/route on | off
/route principal openrouter/z-ai/glm-5.3
/route set three_d openrouter/z-ai/glm-5.3
/route clear three_d
/route reset
```

`maxOutputTokens` evita que OpenRouter reserve la salida máxima del modelo. Sin ese tope, una llamada devolvía HTTP 402 aunque hubiera crédito para la respuesta real. Se puede subir hasta 65.536 si una tarea necesita más salida.

## 3D: qué existe y qué no

**No existe generación de mallas 3D en este proyecto.** El enrutamiento `three_d` cubre texto y código: especificaciones de arte, presupuestos de polígonos, materiales, y módulos Three.js. Un LLM no produce un `.glb`, UVs, texturas PBR ni animaciones esqueléticas por sí solo.

Para generación 3D real haría falta integrar un servicio especializado:

| Etapa | Opciones | Notas |
| --- | --- | --- |
| Texto/imagen → malla | Meshy, Tripo3D, Hunyuan3D, TRELLIS | APIs comerciales o modelos abiertos autoalojados; requieren GPU |
| Retopología / UV | Blender headless, Instant Meshes | Necesario para calidad de producción; la salida generativa suele ser densa |
| Texturizado PBR | Meshy/Tripo, Hunyuan3D-2, TRELLIS, bake en Blender | Revisar licencias y coherencia de seams |
| Validación | `gltf-validator`, Blender | Verificar watertightness, normales, escala y presupuesto |
| Optimización | Draco/meshopt, LOD, atlas | Medir triángulos y draw calls antes de exportar |

Diseño de integración recomendado, no implementado:

```text
prompt → GLM 5.3 genera especificación JSON
       → herramienta generate_3d llama a Meshy/Tripo/Hunyuan3D
       → job queue + polling + descarga GLB
       → Blender headless: retopo, UV, bake, LOD
       → gltf-validator + preview
       → entrega de .glb y metadatos
```

Riesgos: costo por generación, latencia de minutos, licencias de los modelos, resultados no watertight y texturas que no cumplen el presupuesto móvil. Nada de esto se probó porque no hay claves ni pipeline de 3D.

## Verificación en vivo

Última corrida de `npm run check:live` con el tope de 8.192 tokens:

| Modelo | Texto | Tool call | Resultado |
| --- | ---: | ---: | --- |
| Groq · GPT-OSS 120B | 631 ms | 525 ms | `read_file({"path":"src/core/routing.ts"})` |
| NVIDIA · Nemotron 3 Ultra | 1.214 ms | 1.210 ms | `read_file({"path":"src/core/routing.ts"})` |
| OpenRouter · GLM 5.3 | 1.349 ms | 2.677 ms | `read_file({"path":"src/core/routing.ts"})` |
| OpenRouter · DeepSeek V4.1 Flash | 1.152 ms | 9.331 ms | `read_file({"path":"src/core/routing.ts"})` |

Los cuatro devolvieron texto y tool calling válidos. NVIDIA y DeepSeek fueron los más variables entre corridas; DeepSeek agregó una frase antes de la llamada. El detalle y las limitaciones de red (incluida la ventana residual de DNS rebinding en `fetch_url`) están en `docs/TEST-REPORT.md` y `docs/AUDIT.md`.

## Reproducir la evaluación

```powershell
npm run eval -- --dry
npm run eval -- --models=groq-gpt-oss-120b --tasks=code,tool
npm run eval -- --models=gemini-3.8-flash-direct --delay=20000
npm run eval
npm run check:live -- groq/openai/gpt-oss-120b openrouter/z-ai/glm-5.3
```

El detalle completo, incluidos los textos de salida y el uso de tokens, está en `docs/model-eval.json`. Las copias previas a las correcciones de scoring están en `docs/model-eval.pre-*.json`.
