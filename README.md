# Model Tier Router

**El modelo de Claude adecuado para cada tarea, sin pensarlo.** Un plugin de Claude Code que clasifica cada mensaje en tu equipo (sin llamadas a la API y sin gastar tokens), en español o en inglés, y manda el trabajo al nivel que le corresponde: Haiku para lo rápido, Sonnet para el trabajo claro, Opus para lo complejo y Fable solo cuando lo pides. El catálogo de modelos se actualiza solo cada semana a partir de los datos oficiales de Anthropic, así que cuando sale un modelo nuevo no tienes que tocar nada.

Incluye también un bloque para **claude.ai** (web, escritorio, móvil y Cowork) que hace que Claude te avise en una línea cuando te conviene cambiar de modelo.

## Niveles

Esta tabla se regenera sola desde [`models/catalog.json`](models/catalog.json) y [`models/tiers.json`](models/tiers.json):

<!-- tiers:start -->
| Nivel | Modelo | Esfuerzo | Para qué |
|---|---|---|---|
| Rápido | Claude Haiku 5.5 | medium | Consultas, búsquedas, renombrar, formatear, convertir, resumir, extraer datos de un texto, ortografía. |
| Estándar | Claude Sonnet 5.5 | high | Trabajo claro y bien descrito: implementar algo definido, tests, correos, documentos, tablas, análisis que sabes explicar. |
| Profundo | Claude Opus 5.5 | high | Trabajo complejo o aún sin definir: arquitectura, causas desconocidas, decisiones abiertas, cambios en muchos archivos. |
| Máximo | Claude Opus 5.5 | xhigh | Lo más difícil: fallos intermitentes, concurrencia, seguridad, o cuando el nivel Profundo ya falló. |
| Frontera | Claude Fable 5.1 | high | Investigación larga de varios pasos, sesiones de agente de horas, informes completos. Solo a petición o tras dos fallos en Máximo. |
<!-- tiers:end -->

El catálogo completo, con precios y niveles de esfuerzo de cada modelo, está en [`docs/MODELOS.md`](docs/MODELOS.md).

## Qué hace

- **Clasifica cada mensaje en local.** Un hook `UserPromptSubmit` puntúa lo que *escribes* (no lo que pegas: logs, código, facturas o documentos pegados cuentan como material, no como dificultad) y añade una nota corta para la sesión principal. Entiende español con o sin tildes, «¿» y «¡» incluidos.
- **Delega en subagentes con el modelo fijado.** Los hooks no pueden cambiar el modelo de la sesión principal, así que cada nivel es un subagente con el ID real del modelo y su esfuerzo (`claude-haiku-5-5`, `effort: medium`…). Se usan IDs completos y no alias porque un alias como `haiku` puede resolverse a un modelo antiguo.
- **Verifica y escala.** La sesión principal comprueba cada resultado. Si un subagente responde `ESCALATE` o falla la comprobación, reintenta una vez con un encargo más preciso y luego sube un nivel. Fable solo entra a petición (`!fable`) o tras dos fallos en Máximo.
- **Mide lo que cuesta de verdad.** Cada subagente queda registrado con el modelo que corrió de verdad, sus tokens y su coste estimado a precio de lista, incluida la caché de 1 hora y el tramo de contexto largo de Haiku 5.5. `/model-tier-router:router-stats` lo resume.
- **Se mantiene al día solo.** Un workflow semanal lee la documentación de Anthropic (o la Models API si le das una clave), detecta modelos, precios y esfuerzos nuevos, regenera agentes, documentación y el bloque de claude.ai, pasa los tests y abre un PR (o hace commit directo, si lo prefieres).

## Instalación

### Plugin de Claude Code (recomendado)

```
/plugin marketplace add josthanos-crypto/model-tier-router
/plugin install model-tier-router@model-tier-router
```

Reinicia Claude Code o ejecuta `/reload-plugins`. Necesita Node.js 20 o superior en el `PATH` (probado en 22 y 24). Si el repositorio es privado, Claude Code usa tus credenciales de git para clonarlo.

### En un proyecto (también para las sesiones de Claude Code en la nube)

Las sesiones en la nube cargan lo que hay en el repositorio. Desde una copia de este repo:

```bash
node scripts/install.mjs --project /ruta/a/tu/proyecto          # muestra qué hará
node scripts/install.mjs --project /ruta/a/tu/proyecto --yes    # lo instala en .claude/
```

Copia los scripts, los agentes y las skills a `.claude/` del proyecto y añade los hooks a `.claude/settings.json` (con copia de seguridad). Haz commit de esa carpeta. Sin `--project` instala para tu usuario en `~/.claude`. `--uninstall --yes` quita exactamente lo que puso.

### claude.ai (web, escritorio, móvil y Cowork)

Copia el bloque de [`web/claude-ai.md`](web/claude-ai.md) en **Ajustes → Perfil → Preferencias** o en las instrucciones de un Proyecto. Claude te dirá «⚙ Mejor opción: …» solo cuando el modelo elegido encaje claramente mal.

## Uso

Escribe como siempre. Verás una línea como `🧭 deep → Claude Opus 5.5 · high`. Para forzar un nivel en un mensaje:

| Prefijo | Nivel |
|---|---|
| `!fast` o `!rapido` | Rápido |
| `!std`, `!normal` o `!estandar` | Estándar |
| `!deep` o `!profundo` | Profundo |
| `!max` o `!maximo` | Máximo |
| `!fable`, `!frontera` o `!top` | Frontera |
| `!off` o `!sin` | Sin enrutado para ese mensaje |

- `/model-tier-router:router ¿qué modelo uso para revisar un contrato?` responde con el nivel, el modelo y el porqué. Úsalo también para trocear un trabajo grande entre niveles.
- `/model-tier-router:router config` cambia los ajustes.
- `/model-tier-router:router-stats 30` muestra el reparto de niveles y el coste de los subagentes de los últimos 30 días.
- `node scripts/route-prompt.mjs --test "tu mensaje"` enseña qué decidiría el router, sin abrir sesión.

### Ajustes

Van en `~/.claude/model-router/config.json`, donde también se guardan los registros:

```json
{
  "main_model": "opus",
  "enabled": true,
  "log": true,
  "thresholds": { "fast_max_chars": 160, "deep_score": 3, "max_score": 6 }
}
```

- `main_model: "opus"` (por defecto) sigue la recomendación de Anthropic: Opus dirige y delega lo claro en Sonnet. Con `"sonnet"`, Sonnet dirige y pide planes a Opus mediante subagentes. Es más barato, pero piensa menos.
- La variable de entorno `MODEL_ROUTER=off` desactiva los hooks y `MODEL_ROUTER_DATA` cambia la carpeta de datos.
- Los registros guardan el nivel, la puntuación y la longitud de cada mensaje, **nunca su texto**.

## Cómo se actualiza solo

[`.github/workflows/update-models.yml`](.github/workflows/update-models.yml) se ejecuta los lunes, y también a mano desde la pestaña *Actions*:

1. Lee la página de modelos, la de precios y la de esfuerzo de la documentación de Anthropic. Si existe el secreto `ANTHROPIC_API_KEY`, usa además la Models API, que da la familia, el ciclo de vida y los esfuerzos admitidos de cada modelo.
2. Para cada familia que usan los niveles (haiku, sonnet, opus, fable) elige el modelo activo más reciente. Ignora los obsoletos y los de acceso limitado.
3. Si algo no cuadra (un modelo actual sin precio, o sin niveles de esfuerzo), se detiene sin escribir nada. Un cambio de diseño en la documentación no puede publicar un catálogo roto.
4. Regenera agentes, documentación, bloque de claude.ai y esta tabla, pasa los tests y abre un PR con el resumen de cambios.

Si prefieres que se aplique sin revisar, crea la variable de repositorio `MODEL_UPDATE_MODE` con el valor `commit`. Para que pueda abrir PRs, activa *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests*.

Tu instalación recibe los cambios con `/plugin marketplace update model-tier-router`, o sola si tienes activada la actualización automática de marketplaces. Si el catálogo instalado tiene más de 120 días, o un subagente ejecuta un modelo que no conoce, el router te sugiere actualizar una vez al empezar la sesión.

## Qué cuesta y qué no hace

- **Contexto:** unos 660 tokens fijos por sesión (descripciones de skills y agentes, medido con `claude plugin details`), una línea al empezar y una nota de 60 a 100 tokens por mensaje. Los hooks no consumen contexto.
- **El router aconseja; decide la sesión principal.** Con Claude Code 2.1.296, en una prueba real Opus decidió no delegar una consulta de un solo comando ni un fichero de 5 tests: le salía más barato hacerlo él. Es lo correcto, porque arrancar un subagente cuesta unos 32.000 tokens de caché (medido: 0,004 $ en Haiku 5.5, del orden de 0,08 $ en Sonnet 5.5 a precio de lista). Por eso la nota pide delegar solo cuando el trabajo compensa el encargo.
- **No cambia el modelo de la sesión principal.** Ningún hook puede. Si quieres trabajar todo el día en Sonnet, arranca la sesión en Sonnet y pon `"main_model": "sonnet"`.
- **El clasificador es heurístico.** Pasa sus 39 tests de clasificación en español e inglés, pero no se ha medido sobre mensajes reales tuyos. Si falla, usa un prefijo y ajusta `thresholds`.

## De dónde sale

Combina lo mejor de dos proyectos MIT, reescrito y ampliado:

- [shaaz1000/claude-router](https://github.com/shaaz1000/claude-router): la clasificación local sin tokens, el tratamiento del texto pegado como material, los prefijos, los modos «Opus dirige» y «Sonnet dirige», y la idea del bloque para claude.ai.
- [DevstateBelgium/model-router](https://github.com/DevstateBelgium/model-router): los subagentes con ID de modelo fijado, el procedimiento de encargar, verificar y escalar, y la telemetría de coste real por subagente.

Es nuevo en este proyecto: el clasificador en español, el catálogo que se actualiza solo desde los datos oficiales con controles de cordura, los agentes y el bloque de claude.ai generados desde el catálogo, el nivel Frontera con Fable, los esfuerzos ajustados a lo que admite cada modelo, el precio de la caché de 1 hora y del contexto largo, y el instalador por proyecto para las sesiones en la nube. Avisos de licencia en [NOTICE.md](NOTICE.md).

## Desarrollo

Sin dependencias: solo Node.js.

```bash
npm test                 # tests (node:test)
npm run coverage         # tests con cobertura mínima del 80 %
npm run build            # regenera agentes, docs, bloque claude.ai y la tabla de este README
npm run check            # falla si algo generado está desactualizado (lo usa CI)
npm run update-models    # actualiza models/catalog.json desde Anthropic
```

La política (qué familia y qué esfuerzo usa cada nivel) se edita a mano en `models/tiers.json`. El catálogo (`models/catalog.json`) y todo lo generado no se tocan a mano.

## Licencia

[MIT](LICENSE)
