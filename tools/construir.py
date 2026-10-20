#!/usr/bin/env python3
"""Convierte la app publicada como artefacto de Claude en Huellitas (index.html).

Uso:  python3 tools/construir.py RUTA/al/artefacto.html

Cambios que aplica, sin tocar el resto del código de la app:
  - Cabecera propia: nombre Huellitas, ícono, manifest e indicaciones para iPhone.
  - Carga Supabase y huellitas.js antes del código de la app (entregan datos, archivos y personas).
  - Las vistas previas de archivos usan enlaces firmados de Supabase en vez de /_blob/.
  - Textos "Carnet de Mascotas" pasan a "Huellitas".
"""
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'

HEAD = """<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Huellitas</title>
<meta name="description" content="La salud, los horarios y los gastos de tus mascotas en un solo lugar.">
<meta name="theme-color" content="#24102F">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" sizes="48x48" href="icons/favicon-48.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Huellitas">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>:root{color-scheme:light;box-sizing:border-box}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#FBF5EC;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style>
</head>
<body>
"""


def reemplazar(texto, viejo, nuevo, minimo=1):
    n = texto.count(viejo)
    if n < minimo:
        sys.exit(f'No encontré el texto esperado ({n} veces): {viejo[:80]!r}')
    return texto.replace(viejo, nuevo)


def construir(origen: Path) -> str:
    t = origen.read_text(encoding='utf-8')

    # 1. Cabecera: se quita el esqueleto del artefacto, su <title> y la meta de Claude.
    inicio = t.find('<body>')
    if inicio < 0:
        sys.exit('El archivo no parece un artefacto publicado (falta <body>).')
    cuerpo = t[inicio + len('<body>'):]
    cuerpo = re.sub(r'^\s*<title>.*?</title>\s*', '', cuerpo, count=1, flags=re.S)
    cuerpo = re.sub(r'<meta name="claude:[^"]*"[^>]*>\s*', '', cuerpo)
    cuerpo = re.sub(r'</body>\s*</html>\s*$', '', cuerpo.rstrip())

    # 2. Supabase y huellitas.js justo antes del código principal de la app.
    principal = cuerpo.find('<script>\n(function () {')
    if principal < 0:
        sys.exit('No encontré el código principal de la app.')
    cuerpo = (cuerpo[:principal]
              + f'<script src="{SUPABASE_JS}"></script>\n<script src="huellitas.js"></script>\n'
              + cuerpo[principal:])

    # 3. Archivos: enlaces firmados de Supabase.
    cuerpo = reemplazar(cuerpo, "function blobUrl(id) { return '/_blob/' + esc(id); }",
                        'function blobUrl(id) { return window.HUELLITAS.blobUrl(id); }')
    # GIF no está permitido en el almacén: la app lo convierte a JPG antes de subirlo.
    cuerpo = cuerpo.replace(", 'image/gif': 1 };", ' };')

    # 4. Privacidad: el código queda público, así que se quitan los datos de ejemplo
    #    (eran datos reales de Bruno y Lucas, usados solo en la vista previa del artefacto).
    a = cuerpo.find('  function seedDemo(d) {')
    b = cuerpo.find('  function subscribe() {')
    if a < 0 or b < a:
        sys.exit('No encontré los datos de ejemplo para quitarlos.')
    cuerpo = cuerpo[:a] + '  function seedDemo() { /* sin datos de ejemplo en la versión pública */ }\n\n' + cuerpo[b:]

    # 5. Nombre.
    cuerpo = cuerpo.replace('Carnet de<br>Mascotas', 'Huellitas')
    cuerpo = cuerpo.replace('Carnet de Mascotas', 'Huellitas')

    return HEAD + cuerpo.strip() + '\n</body>\n</html>\n'


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    salida = RAIZ / 'index.html'
    salida.write_text(construir(Path(sys.argv[1])), encoding='utf-8')
    print(f'Listo: {salida}')
