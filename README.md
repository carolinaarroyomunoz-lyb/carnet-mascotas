# Carnet de Mascotas

App para registrar la salud, los tratamientos, la alimentación y los gastos de nuestras mascotas.

- Se instala en el celular desde el navegador (iPhone y Android).
- Los datos se guardan en Supabase, protegidos por inicio de sesión: cada hogar ve solo lo suyo.
- Este repositorio contiene solo el código de la app, no los datos.

## Archivos

- `index.html`: la app. Se genera con `tools/construir.py` a partir de la versión publicada como artefacto de Claude.
- `huellitas.js`: conexión con Supabase (inicio de sesión, datos, archivos e importación de respaldos).
- `manifest.webmanifest`, `sw.js` e `icons/`: permiten instalarla en el celular.

## Actualizar la app

```
python3 tools/construir.py ruta/al/artefacto.html
```
