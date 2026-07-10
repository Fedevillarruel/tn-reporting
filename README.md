# Reporting TN

Aplicacion para Tiendanube que permite:

- Conectar rapidamente una tienda por `storeId + accessToken`
- Sincronizar ventas
- Filtrar por fecha y producto
- Generar un link compartible con clave
- Ver reporte en vivo y descargar PDF actualizado

## Requisitos

- Node.js 20+

## Instalacion

1. Instala dependencias:

```bash
npm install
```

2. Configura variables:

```bash
cp .env.example .env
```

3. Inicia en desarrollo:

```bash
npm run dev
```

4. Abre:

```text
http://localhost:3000
```

## Flujo rapido

1. Completa `storeId` y `accessToken` en la UI
2. Click en `Sincronizar ventas ahora`
3. Aplica filtros
4. Crea reporte con nombre y clave
5. Comparte `shareUrl` y clave
6. El receptor ve el reporte en `share.html` con actualizacion en vivo

## Endpoints principales

- `POST /api/connection` guarda credenciales
- `POST /api/tiendanube/sync` sincroniza ventas
- `GET /api/oauth/callback` completa OAuth desde Tiendanube Partners
- `GET /api/sales` lista ventas filtradas
- `POST /api/reports` crea link protegido
- `GET /api/reports/:slug?password=...` obtiene resumen
- `GET /api/reports/:slug/stream?password=...` actualizaciones SSE
- `GET /api/reports/:slug/pdf?password=...` PDF

## Nota sobre autenticacion Tiendanube

La app soporta callback OAuth via `GET /api/oauth/callback` para guardar el token de la tienda instalada.

Variables necesarias para Partners:

- `TN_APP_ID`
- `TN_CLIENT_SECRET`
- `TN_APP_URL` (ejemplo `https://tn-reporting.vercel.app`)

Cuando Tiendanube redirige con `code` y `store_id`, el backend intercambia el token y deja activa esa tienda para sincronizacion.

## Deploy en Vercel

- Se agrega `api/index.js` como entrypoint serverless.
- En Vercel, el storage JSON usa `/tmp/reporting.json` para evitar el error por filesystem de solo lectura.
- El reporte compartido usa refresco cada 15 segundos para ser compatible con serverless.

Limitacion importante:

- En Vercel, el storage en `/tmp` es efimero. Sirve para demo o pruebas, pero para persistencia real debes mover ventas, credenciales y reportes a una base externa como Supabase o Vercel Postgres.
