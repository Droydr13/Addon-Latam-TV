# Addon Latam - Canales

Addon de Stremio 100% estático (sin servidor propio) para tu lista de
canales en vivo. Se genera a partir de `list.m3u` con `build.js`.

## Qué hace `build.js`

Lee `list.m3u` y arma la carpeta `dist/` con todo lo que Stremio necesita:

```
dist/
  manifest.json
  catalog/tv/addonlatam-canales.json
  meta/tv/<id>.json      (uno por canal)
  stream/tv/<id>.json    (uno por canal)
```

Los canales de tu lista que todavía **no tienen URL de stream cargada**
(los dejaste con el nombre/logo puesto pero sin línea de link abajo) se
saltean automáticamente — no aparecen en el addon hasta que les
agregues la URL. Ahora mismo eso pasa con varios (Star Channel, Warner
Channel, FX, Universal TV, TLC, TNT Novelas, TLNovelas, Telemundo,
Unicable, Comedy Central, Distrito Comedia, Sony Novelas, entre otros)
— quedaron afuera de este build por eso, no por un error.

## Primera vez: subir a GitHub

1. Creá un repo nuevo en GitHub (puede ser público, no necesita nada especial).
2. Subí el **contenido de `dist/`** a la raíz del repo (no la carpeta `dist` en sí — el `manifest.json` tiene que quedar en la raíz).
3. La URL para instalar el addon en Stremio va a ser:
   ```
   https://raw.githubusercontent.com/TU-USUARIO/TU-REPO/main/manifest.json
   ```
   (cambiá `TU-USUARIO` y `TU-REPO`, y `main` si tu rama por defecto se llama distinto)

## Cada vez que querés agregar/sacar canales

**Opción A — más simple, sin usar este script:**
Editá `list.m3u` directo en github.com, y a mano corregí a la vez
`catalog/tv/addonlatam-canales.json` agregando/sacando la entrada
correspondiente y su `meta/tv/<id>.json` + `stream/tv/<id>.json`. Es
más manual pero no necesitás Node en tu compu para cambios chicos.

**Opción B — recomendada, con este script:**
1. Editá `list.m3u` (localmente o bajándolo de GitHub) para agregar, sacar o cambiar canales.
2. Corré `node build.js`.
3. Subí de nuevo el contenido de `dist/` a tu repo (sobreescribiendo lo que cambió).

El `manifest.json` casi no cambia nunca — lo que se actualiza siempre
es `catalog/tv/addonlatam-canales.json` y las carpetas `meta/` y `stream/`.

## Sobre la EPG

Este addon no lee ni muestra ninguna EPG — Stremio no tiene forma de
mostrar una guía de programación, así que da igual cómo armemos esto.
Tu `list.m3u` original (con los `tvg-id` que ya tenés adaptados a tu
EPG específica) la dejás aparte, sin tocar, y se la das a quien la pida
junto con la URL de tu XMLTV para que las cargue juntas en algún
reproductor que sí soporte esa combinación (fuera de Stremio). El
`build.js` no modifica ni descarta esos `tvg-id` — solo no los usa,
porque el addon de Stremio no los necesita para nada.
