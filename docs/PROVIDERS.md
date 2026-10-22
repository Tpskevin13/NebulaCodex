# Proveedores incluidos

Todo se configura dentro de la aplicación con `/providers`: elegís el proveedor, pegás la API key y NebulaCodex guarda
la configuración en `~/.nebulacodex/config.json` (permisos 0600 en Linux y macOS).

Si no hay una API key guardada para un proveedor, NebulaCodex usa la variable de entorno de la columna **Variable** (si existe).
Así podés trabajar sin escribir la clave en ningún archivo:

```bash
export GROQ_API_KEY="..."      # Linux / macOS
```

```powershell
$env:GROQ_API_KEY = "..."      # PowerShell
```

El modelo de la columna **Modelo por defecto** es sólo el valor inicial; se puede cambiar con `/model` o `/providers`.
Los identificadores de modelo cambian con el tiempo: verificá el nombre vigente en la documentación del proveedor.

| Proveedor | ID | Variable de la API key | Modelo por defecto | Notas |
| --- | --- | --- | --- | --- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` | Claude vía API oficial (API de Anthropic) |
| NVIDIA NIM | `nvidia` | `NVIDIA_API_KEY` | `meta/llama-3.3-70b-instruct` | build.nvidia.com (tiene cuota gratis) |
| Ollama | `ollama` | no | `qwen2.5-coder` | Elegí un modelo local o cloud de Ollama |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` | aistudio.google.com (tiene capa gratis) |
| Groq | `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | Inferencia ultrarrápida |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.5` | Cientos de modelos con una sola key |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4.1` | API oficial de OpenAI |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-flash` | API compatible con OpenAI |
| xAI | `xai` | `XAI_API_KEY` | `grok-4.7` | Modelos Grok |
| Mistral AI | `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` | API compatible con OpenAI |
| Together AI | `together` | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Inferencia de modelos abiertos |
| Fireworks AI | `fireworks` | `FIREWORKS_API_KEY` | `accounts/fireworks/models/llama-v3p3-70b-instruct` | API compatible con OpenAI |
| DeepInfra | `deepinfra` | `DEEPINFRA_API_KEY` | `deepseek-ai/DeepSeek-V4-Flash-0731` | Catálogo de modelos abiertos |
| SambaNova | `sambanova` | `SAMBANOVA_API_KEY` | `DeepSeek-V3.1` | SambaCloud Inference API |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` | `llama-3.3-70b` | Inferencia rápida compatible con OpenAI |
| Hugging Face | `huggingface` | `HF_TOKEN` | `Qwen/Qwen3-4B-Instruct-2507` | Inference Providers y modelos compatibles |
| Cohere | `cohere` | `COHERE_API_KEY` | `command-a-03-2025` | Compatibility API para chat y herramientas |
| Perplexity | `perplexity` | `PERPLEXITY_API_KEY` | `sonar-pro` | Modelos Sonar con búsqueda web |
| Moonshot AI (Kimi) | `moonshot` | `MOONSHOT_API_KEY` | `kimi-k2.5` | API compatible con OpenAI |
| Zhipu AI (Z.AI / GLM) | `zhipu` | `ZAI_API_KEY` | `glm-4.6` | API compatible con OpenAI |
| Baichuan AI | `baichuan` | `BAICHUAN_API_KEY` | `Baichuan4` | API de chat compatible con OpenAI |
| Alibaba Cloud (Qwen) | `qwen` | `DASHSCOPE_API_KEY` | `qwen-plus` | Model Studio / DashScope; endpoint regional editable (URL editable) |
| Novita AI | `novita` | `NOVITA_API_KEY` | `deepseek/deepseek-v3.1` | Inferencia de modelos abiertos |
| Microsoft Azure AI | `azure-openai` | `AZURE_OPENAI_API_KEY` | `TU-NOMBRE-DE-DEPLOYMENT` | Azure OpenAI v1; ingresá la URL del recurso y el deployment (URL editable) |
| Modal | `modal` | no | `TU-MODELO` | Endpoint de inferencia OpenAI-compatible desplegado en Modal (URL editable) |
| Lepton AI | `lepton` | `LEPTON_API_TOKEN` | `TU-MODELO` | Usá la URL de tu endpoint desplegado (URL editable) |
| Personalizado | `custom` | no | `mi-modelo` | Cualquier endpoint compatible con OpenAI |

> Esta tabla se genera con `node scripts/gen-providers-doc.mjs`. Cualquier endpoint compatible con OpenAI funciona con el proveedor **Personalizado** (`custom`).
